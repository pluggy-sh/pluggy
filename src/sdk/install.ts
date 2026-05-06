/**
 * Download + extract pipeline for cached JDKs. Generalized from the JBR
 * provisioner (`src/dev/jbr.ts`) — same atomic-rename / staging-dir pattern,
 * extended to cover Windows zip archives.
 *
 * The system `tar` (macOS, Linux, Windows 10+) handles `.tar.gz`. Windows
 * `.zip` extraction uses PowerShell's `Expand-Archive` to avoid pulling in
 * a JS-side zip dependency. Both go through `spawn` directly — never a
 * shell — so cross-platform parity matches the rest of the codebase.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";

import { log } from "../logging.ts";

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
  /** Cache slot root — the directory the archive extracted into. */
  slotRoot: string;
  /** Absolute path to the `java` executable inside the slot. */
  javaPath: string;
}

/**
 * Download (if needed) and extract `spec` into the cache. Atomic: a partial
 * extract on crash leaves no slot behind. Records the install in the
 * manifest so `pluggy sdk gc` can LRU-evict later.
 */
export async function installJdk(spec: JdkSpec): Promise<InstallResult> {
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

  // Download archive if missing. We deliberately keep archives around in
  // <cacheRoot>/jdk/archives so a re-extract (after manual slot deletion)
  // doesn't redownload — `pluggy sdk gc` is what cleans them up.
  if (!existsSync(archive)) {
    await downloadArchive(spec, archive);
  }

  // Extract into a per-run staging dir; rename atomically into the slot.
  // If the slot already exists from a previous (broken) install, drop it.
  if (existsSync(slot)) {
    await rm(slot, { recursive: true, force: true });
  }
  await extractArchive(archive, spec.archiveType, slot);

  const javaPath = javaBinaryPath(slot, spec.os);
  if (!existsSync(javaPath)) {
    throw new Error(
      `sdk: extraction completed but ${javaPath} is missing — archive layout may differ from expectation`,
    );
  }

  await recordEntry(key, parts, spec.fullVersion);
  return { slotRoot: slot, javaPath };
}

async function downloadArchive(spec: JdkSpec, destPath: string): Promise<void> {
  const sizeNote = spec.sizeBytes !== undefined ? ` (~${formatMb(spec.sizeBytes)})` : "";
  log.info(`sdk: downloading ${spec.distribution} ${spec.fullVersion}${sizeNote}…`);

  const res = await fetch(spec.downloadUrl, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(`sdk: download failed (${res.status} ${res.statusText}) — ${spec.downloadUrl}`);
  }

  await mkdir(dirname(destPath), { recursive: true });
  const tmpPath = `${destPath}.partial`;
  // We allocate a single buffer rather than streaming to disk because Bun's
  // single-file binary doesn't ship a `Readable.fromWeb` polyfill that's
  // reliable across platforms — and JDK archives are bounded (≈200 MB).
  // Worth revisiting if we ever cache larger artifacts.
  const buf = new Uint8Array(await res.arrayBuffer());
  await writeFile(tmpPath, buf);
  await rename(tmpPath, destPath);
  log.debug(`sdk: cached archive at ${destPath} (${buf.byteLength} bytes)`);
}

/**
 * Extract `archive` (.tar.gz or .zip) into `expectedRoot`. The archive is
 * unpacked into a sibling temp dir first; we then verify exactly one
 * top-level directory and rename it into place. This matches `dev/jbr.ts`'s
 * approach so a partial extract never poisons the cache.
 */
async function extractArchive(
  archive: string,
  archiveType: "tar.gz" | "zip",
  expectedRoot: string,
): Promise<void> {
  const stagingDir = join(tmpdir(), `pluggy-jdk-${Date.now()}-${process.pid}`);
  await mkdir(stagingDir, { recursive: true });

  log.info("sdk: extracting JDK…");
  try {
    if (archiveType === "tar.gz") {
      await runTar(archive, stagingDir);
    } else {
      await runUnzip(archive, stagingDir);
    }

    const entries = await readdir(stagingDir, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory());
    if (dirs.length === 0) {
      throw new Error(`sdk: archive produced no directories inside ${stagingDir}`);
    }
    if (dirs.length > 1) {
      throw new Error(
        `sdk: archive produced ${dirs.length} top-level directories — expected exactly one`,
      );
    }

    const extractedSrc = join(stagingDir, dirs[0].name);
    await rename(extractedSrc, expectedRoot);
    log.debug(`sdk: JDK ready at ${expectedRoot}`);
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
}

function runTar(archive: string, destDir: string): Promise<void> {
  return runProcess("tar", ["-xzf", archive, "-C", destDir]);
}

/**
 * Use PowerShell's Expand-Archive on Windows; everything else has unzip
 * available (macOS/Linux ship it). Direct spawn — no shell.
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
      rejectPromise(new Error(`sdk: failed to spawn ${cmd}: ${err.message}`));
    });
    child.once("exit", (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(new Error(`sdk: ${cmd} exited with code ${code}: ${stderr.trim()}`));
    });
  });
}

function formatMb(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}
