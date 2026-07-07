/**
 * Download + extract pipeline for cached JDKs. The system `tar` (macOS,
 * Linux, Windows 10+) handles `.tar.gz`; Windows `.zip` falls back to
 * PowerShell's `Expand-Archive` to avoid a JS-side zip dependency. Both
 * spawn directly (never a shell).
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";

import { RuntimeError } from "../errors.ts";
import { log } from "../logging.ts";
import { writeFileAtomic } from "../portable.ts";

import {
  archivePath,
  cacheKey,
  ensureCacheDirs,
  javaBinaryPath,
  recordEntry,
  slotPath,
  type CacheKeyParts,
} from "./cache.ts";
import type { JdkSpec } from "./disco.ts";

export interface InstallResult {
  /** Cache slot root: the directory the archive extracted into. */
  slotRoot: string;
  /** Absolute path to the `java` executable inside the slot. */
  javaPath: string;
}

export interface InstallJdkOptions {
  /** Drop any cached archive and re-download. `sdk install --force` sets this. */
  freshArchive?: boolean;
}

/**
 * Download (if needed) and extract `spec` into the cache. Atomic: a partial
 * extract on crash leaves no slot behind, and an existing slot is only
 * replaced after the new archive is downloaded, verified, and extracted, so
 * a failed reinstall never strands the user without a JDK. Records the
 * install in the manifest so `pluggy cache prune` can LRU-evict later.
 */
export async function installJdk(
  spec: JdkSpec,
  opts: InstallJdkOptions = {},
): Promise<InstallResult> {
  await ensureCacheDirs();

  const parts: CacheKeyParts = {
    distribution: spec.distribution,
    major: spec.major,
    os: spec.os,
    arch: spec.arch,
  };
  const key = cacheKey(parts);
  const slot = slotPath(key);
  const archive = archivePath(key, spec.archiveType);

  if (opts.freshArchive === true) {
    await rm(archive, { force: true });
  }

  // Download archive if missing. We deliberately keep archives around in
  // <cacheRoot>/jdk/archives so a re-extract (after manual slot deletion)
  // doesn't redownload; `pluggy cache prune --category jdk` is what cleans them up.
  if (existsSync(archive)) {
    // A cached archive whose hash drifts from Disco's published value is
    // either corrupt or a leftover from before the integrity story; drop
    // and redownload rather than risk extracting tampered bytes.
    if (spec.checksum !== undefined) {
      const cachedHash = await hashFile(archive, spec.checksum.algorithm);
      if (cachedHash !== spec.checksum.value) {
        log.warn(
          `Cached archive at ${archive} has unexpected ${spec.checksum.algorithm} ${cachedHash} (expected ${spec.checksum.value}); re-downloading`,
        );
        await rm(archive, { force: true });
      }
    }
  }
  if (!existsSync(archive)) {
    await downloadArchive(spec, archive);
  }

  // Extract into a per-run staging dir and verify the layout there. Only
  // then is any existing slot dropped and the staged tree renamed into
  // place, so every failure mode up to the swap leaves the old JDK usable.
  const stagingDir = join(tmpdir(), `pluggy-jdk-${Date.now()}-${process.pid}`);
  await mkdir(stagingDir, { recursive: true });
  try {
    const extractedRoot = await extractToStaging(archive, spec.archiveType, stagingDir);
    const stagedJava = javaBinaryPath(extractedRoot, spec.os);
    if (!existsSync(stagedJava)) {
      throw new RuntimeError(
        `Extraction completed but ${stagedJava} is missing; archive layout may differ from expectation`,
        {
          code: "E_SDK_EXTRACT_LAYOUT",
          hint: "Wipe the JDK cache with `pluggy cache clean --category jdk` and retry.",
          context: {
            javaPath: stagedJava,
            distribution: spec.distribution,
            version: spec.fullVersion,
          },
        },
      );
    }

    if (existsSync(slot)) {
      await rm(slot, { recursive: true, force: true });
    }
    await rename(extractedRoot, slot);
    log.debug(`JDK ready at ${slot}`);
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }

  await recordEntry(key, parts, spec.fullVersion);
  return { slotRoot: slot, javaPath: javaBinaryPath(slot, spec.os) };
}

async function downloadArchive(spec: JdkSpec, destPath: string): Promise<void> {
  const sizeNote = spec.sizeBytes !== undefined ? ` (~${formatMb(spec.sizeBytes)})` : "";
  log.step(`Downloading ${spec.distribution} ${spec.fullVersion}${sizeNote}…`);

  // Refuse to follow non-HTTPS Disco redirects: JDK CDNs are HTTPS-only,
  // a downgrade is an attack signal worth aborting on.
  if (!spec.downloadUrl.startsWith("https://")) {
    throw new RuntimeError(
      `Refusing non-https download URL ${JSON.stringify(spec.downloadUrl)}: Disco redirected to a plaintext target`,
      {
        code: "E_SDK_INSECURE_URL",
        hint: "Retry; if it persists, the Disco mirror may be misconfigured.",
        context: { url: spec.downloadUrl },
      },
    );
  }

  const res = await fetch(spec.downloadUrl, { redirect: "follow" });
  if (!res.ok) {
    throw new RuntimeError(
      `JDK download failed (${res.status} ${res.statusText}): ${spec.downloadUrl}`,
      {
        code: "E_SDK_DOWNLOAD",
        hint: "Check connectivity and retry.",
        context: { status: res.status, statusText: res.statusText, url: spec.downloadUrl },
      },
    );
  }

  await mkdir(dirname(destPath), { recursive: true });
  // We allocate a single buffer rather than streaming to disk because Bun's
  // standalone binary doesn't ship a `Readable.fromWeb` polyfill that's
  // reliable across platforms; and JDK archives are bounded (≈200 MB).
  // Worth revisiting if we ever cache larger artifacts.
  const buf = new Uint8Array(await res.arrayBuffer());

  if (spec.checksum !== undefined) {
    const actual = createHash(spec.checksum.algorithm).update(buf).digest("hex");
    if (actual !== spec.checksum.value) {
      throw new RuntimeError(
        `Integrity check failed for ${spec.distribution} ${spec.fullVersion} (${spec.os}/${spec.arch}): ` +
          `Disco published ${spec.checksum.algorithm} ${spec.checksum.value}, downloaded bytes hash to ${actual}. ` +
          `Refusing to extract a tampered runtime.`,
        {
          code: "E_SDK_INTEGRITY",
          hint: "Wipe the JDK cache with `pluggy cache clean --category jdk` and retry.",
          context: {
            distribution: spec.distribution,
            version: spec.fullVersion,
            algorithm: spec.checksum.algorithm,
            expected: spec.checksum.value,
            actual,
          },
        },
      );
    }
  } else {
    log.warn(
      `${spec.distribution} ${spec.fullVersion} (${spec.os}/${spec.arch}) was downloaded without an upstream checksum: Disco didn't publish one for this package`,
    );
  }

  await writeFileAtomic(destPath, buf);
  log.debug(`Cached JDK archive at ${destPath} (${buf.byteLength} bytes)`);
}

async function hashFile(
  path: string,
  algorithm: "sha256" | "sha512" | "sha1" | "md5",
): Promise<string> {
  const bytes = await readFile(path);
  return createHash(algorithm).update(bytes).digest("hex");
}

/**
 * Extract `archive` (.tar.gz or .zip) into `stagingDir`, verify exactly one
 * top-level directory, and return that directory's path. The caller owns
 * `stagingDir` cleanup and the rename into the cache slot; this matches
 * `dev/jbr.ts`'s approach so a partial extract never poisons the cache.
 */
async function extractToStaging(
  archive: string,
  archiveType: "tar.gz" | "zip",
  stagingDir: string,
): Promise<string> {
  log.step("Extracting JDK…");
  if (archiveType === "tar.gz") {
    await runTar(archive, stagingDir);
  } else {
    await runUnzip(archive, stagingDir);
  }

  const entries = await readdir(stagingDir, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory());
  if (dirs.length === 0) {
    throw new RuntimeError(`JDK archive produced no directories inside ${stagingDir}`, {
      code: "E_SDK_EXTRACT_LAYOUT",
      hint: "Wipe the JDK cache with `pluggy cache clean --category jdk` and retry.",
      context: { stagingDir },
    });
  }
  if (dirs.length > 1) {
    throw new RuntimeError(
      `JDK archive produced ${dirs.length} top-level directories; expected exactly one`,
      {
        code: "E_SDK_EXTRACT_LAYOUT",
        hint: "Wipe the JDK cache with `pluggy cache clean --category jdk` and retry.",
        context: { stagingDir, dirs: dirs.map((d) => d.name) },
      },
    );
  }

  return join(stagingDir, dirs[0].name);
}

function runTar(archive: string, destDir: string): Promise<void> {
  return runProcess("tar", ["-xzf", archive, "-C", destDir]);
}

/**
 * Use PowerShell's Expand-Archive on Windows; everything else has unzip
 * available (macOS/Linux ship it). Direct spawn; no shell.
 */
function runUnzip(archive: string, destDir: string): Promise<void> {
  if (process.platform === "win32") {
    return runProcess("powershell.exe", [
      "-NoProfile",
      "-Command",
      `Expand-Archive -LiteralPath '${archive.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`,
    ]);
  }
  return runProcess("unzip", ["-q", archive, "-d", destDir]);
}

function runProcess(cmd: string, args: string[]): Promise<void> {
  return new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", (err) => {
      rejectPromise(new Error(`Failed to spawn ${cmd}: ${err.message}`));
    });
    child.once("exit", (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(new Error(`${cmd} exited with code ${code}: ${stderr.trim()}`));
    });
  });
}

function formatMb(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}
