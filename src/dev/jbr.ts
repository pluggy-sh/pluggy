/**
 * JetBrains Runtime (JBR) provisioning. Downloads the `jbrsdk` archive for
 * the host OS/arch, extracts it under `<cachePath>/jbr/<key>/`, and exposes
 * the absolute path to the bundled `java` binary.
 *
 * JBR ships DCEVM enhanced class redefinition out of the box since 17. Pair
 * the resolved `java` with `-XX:+AllowEnhancedClassRedefinition` and a
 * `-javaagent:` pointing at HotswapAgent and class redefinitions stop being
 * limited to method bodies.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { log } from "../logging.ts";
import { getCachePath } from "../project.ts";

/**
 * Pinned JBR build. Bumping these constants is the only way to upgrade the
 * runtime; users don't pick versions, we ship the same one to everyone.
 *
 * Update by browsing https://github.com/JetBrains/JetBrainsRuntime/releases
 * and copying the `jbrsdk-<version>-<os>-<arch>-<build>.tar.gz` filename.
 * After bumping the version/build, also recompute the per-target SHA-256s
 * in `JBR_SHA256`. Without that, the integrity check fails fast and dev
 * mode refuses to run, which is the safe default.
 */
export const JBR_VERSION = "25.0.2";
export const JBR_BUILD = "b432.48";

/**
 * Expected SHA-256 of each JBR tarball, keyed by `${os}-${arch}`. Verified
 * after download and before extraction. A mismatch aborts with a clear error
 * (corrupt cache or hostile substitution both surface here). Bake new values
 * by running `shasum -a 256 jbrsdk-<version>-<os>-<arch>-<build>.tar.gz`
 * against the official archive.
 */
const JBR_SHA256: Record<string, string> = {
  "osx-aarch64": "1501ed8f15c1176abc895d6e3cf2b52562152f9731ec024b552e4bef24f02bf9",
  "osx-x64": "aeb433aef8bedcd8ba32963857923096a03bd87ca6ebb7a65a79d8b41b97dec3",
  "linux-aarch64": "b2a7e10c80b9560bee42e2f6f69d4491dc74362a7ca378249ec545a83155eb57",
  "linux-x64": "a76e8c1ef916f84d3b28e6794d1527d5189f9b0299a323e21ea737bdd93eaddd",
  "windows-x64": "48bf62ff4d61969066d71012e98ed6ef1292c4709badb099e22ed07195b00527",
};

interface JbrTarget {
  /** "osx" | "linux" | "windows", JBR's own naming. */
  os: "osx" | "linux" | "windows";
  /** "aarch64" | "x64", JBR's own naming. */
  arch: "aarch64" | "x64";
}

/**
 * Map `process.platform` + `process.arch` to JBR's filename convention.
 * Throws fail-early on unsupported combinations (32-bit, ppc, etc.).
 */
export function jbrTarget(): JbrTarget {
  const platform = process.platform;
  const arch = process.arch;

  let os: JbrTarget["os"];
  if (platform === "darwin") os = "osx";
  else if (platform === "linux") os = "linux";
  else if (platform === "win32") os = "windows";
  else throw new Error(`jbr: unsupported platform "${platform}"; JBR is not published for it`);

  let normalizedArch: JbrTarget["arch"];
  if (arch === "arm64") normalizedArch = "aarch64";
  else if (arch === "x64") normalizedArch = "x64";
  else throw new Error(`jbr: unsupported arch "${arch}"; JBR ships x64 and aarch64 only`);

  return { os, arch: normalizedArch };
}

/** Filename of the JBR archive for the given target. */
export function jbrArchiveName(target: JbrTarget): string {
  return `jbrsdk-${JBR_VERSION}-${target.os}-${target.arch}-${JBR_BUILD}.tar.gz`;
}

/** Cache key used as the extracted directory name. Stable per (version, os, arch, build). */
export function jbrCacheKey(target: JbrTarget): string {
  return `jbrsdk-${JBR_VERSION}-${target.os}-${target.arch}-${JBR_BUILD}`;
}

/**
 * Path to the `java` binary inside an extracted JBR. JBR on macOS ships as
 * a Mac app bundle (`Contents/Home/bin/java`); Linux and Windows are flat.
 */
export function jbrJavaPath(extractedRoot: string, target: JbrTarget): string {
  const bin = target.os === "windows" ? "java.exe" : "java";
  if (target.os === "osx") {
    return join(extractedRoot, "Contents", "Home", "bin", bin);
  }
  return join(extractedRoot, "bin", bin);
}

/**
 * Resolve a usable JBR `java` path, downloading + extracting on cache miss.
 * Returns the absolute path to the `java` executable.
 *
 * Idempotent: a second call with a populated cache is a single existsSync.
 */
export async function ensureJbr(): Promise<string> {
  const target = jbrTarget();
  const cacheRoot = join(getCachePath(), "jbr");
  const extractedRoot = join(cacheRoot, jbrCacheKey(target));
  const javaPath = jbrJavaPath(extractedRoot, target);

  if (existsSync(javaPath)) return javaPath;

  await mkdir(cacheRoot, { recursive: true });

  const expectedSha = expectedShaFor(target);
  const archiveName = jbrArchiveName(target);
  const archivePath = join(cacheRoot, archiveName);
  if (existsSync(archivePath)) {
    // A cached archive that doesn't match the pinned hash is rejected: it's
    // either corrupt or substituted out of band. Drop and redownload.
    const cachedSha = await sha256OfFile(archivePath);
    if (cachedSha !== expectedSha) {
      log.warn(
        `hotswap: cached JBR archive at ${archivePath} has unexpected sha256 ${cachedSha} (expected ${expectedSha}); re-downloading`,
      );
      await rm(archivePath, { force: true });
    }
  }
  if (!existsSync(archivePath)) {
    await downloadArchive(archiveName, archivePath, expectedSha);
  }

  await extractInto(archivePath, cacheRoot, extractedRoot);

  if (!existsSync(javaPath)) {
    throw new Error(
      `jbr: extraction completed but ${javaPath} is missing; archive layout may have changed`,
    );
  }
  return javaPath;
}

function expectedShaFor(target: JbrTarget): string {
  const key = `${target.os}-${target.arch}`;
  const sha = JBR_SHA256[key];
  if (sha === undefined) {
    throw new Error(
      `jbr: no pinned SHA-256 for ${key}; refusing to download an unverified runtime. ` +
        `Add the expected hash to JBR_SHA256 in src/dev/jbr.ts.`,
    );
  }
  return sha;
}

async function sha256OfFile(path: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  const bytes = await readFile(path);
  return createHash("sha256").update(bytes).digest("hex");
}

const JBR_CDN = "https://cache-redirector.jetbrains.com/intellij-jbr";

async function downloadArchive(
  archiveName: string,
  destPath: string,
  expectedSha: string,
): Promise<void> {
  const url = `${JBR_CDN}/${archiveName}`;
  log.step(`Downloading JetBrains Runtime (${archiveName})…`);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`jbr: download failed (${res.status} ${res.statusText}): ${url}`);
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  const actualSha = createHash("sha256").update(buf).digest("hex");
  if (actualSha !== expectedSha) {
    throw new Error(
      `jbr: integrity check failed for ${archiveName}: expected sha256 ${expectedSha}, got ${actualSha}. ` +
        `Refusing to extract an unverified runtime; please report at https://github.com/pluggy-sh/pluggy/issues.`,
    );
  }
  const tmpPath = `${destPath}.partial`;
  const { writeFile } = await import("node:fs/promises");
  await writeFile(tmpPath, buf);
  await rename(tmpPath, destPath);
  log.debug(`Cached JBR archive at ${destPath} (${buf.byteLength} bytes)`);
}

/**
 * Extract `archivePath` (a `.tar.gz`) into `cacheRoot`, then move the
 * top-level directory to `expectedRoot`. JBR archives unpack to a directory
 * named after the archive without the `.tar.gz` suffix; we rename it to our
 * canonical `cacheKey` form so callers can resolve `java` deterministically.
 *
 * Uses the system `tar` (built into macOS, Linux, and Windows 10+) via a
 * direct spawn (never a shell) to keep cross-platform parity.
 */
async function extractInto(
  archivePath: string,
  cacheRoot: string,
  expectedRoot: string,
): Promise<void> {
  // Extract to a sibling temp dir first so a partial extraction on crash
  // doesn't poison the cache slot.
  const stagingDir = join(tmpdir(), `pluggy-jbr-${Date.now()}-${process.pid}`);
  await mkdir(stagingDir, { recursive: true });

  log.step("Extracting JetBrains Runtime…");
  await runTar(archivePath, stagingDir);

  const entries = await readdir(stagingDir, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory());
  if (dirs.length === 0) {
    throw new Error(`jbr: tar produced no directories inside ${stagingDir}`);
  }
  // Conventional layout: a single top-level dir. If JBR ever ships multiple
  // directories at the root we'd need to revisit; surface that explicitly.
  if (dirs.length > 1) {
    throw new Error(`jbr: tar produced ${dirs.length} top-level directories; expected exactly one`);
  }

  const extractedSrc = join(stagingDir, dirs[0].name);
  // Rename into place. If a previous run left a stale cache slot, nuke it
  // first; we already verified the `java` binary was missing.
  if (existsSync(expectedRoot)) {
    await rm(expectedRoot, { recursive: true, force: true });
  }
  await rename(extractedSrc, expectedRoot);
  await rm(stagingDir, { recursive: true, force: true });
  log.debug(`JBR ready at ${expectedRoot}`);
  // `cacheRoot` is unused in this branch but kept for symmetry with future
  // multi-target layouts (for example, side-by-side build IDs).
  void cacheRoot;
}

function runTar(archivePath: string, destDir: string): Promise<void> {
  return new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn("tar", ["-xzf", archivePath, "-C", destDir], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", (err) => {
      rejectPromise(new Error(`jbr: failed to spawn tar: ${err.message}`));
    });
    child.once("exit", (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(new Error(`jbr: tar exited with code ${code}: ${stderr.trim()}`));
    });
  });
}
