/**
 * SDK orchestration layer. Public entry points for the rest of the codebase:
 *
 *   * `ensureJdk(major, opts?)` — return a usable JDK for the given Java
 *     major. Cache hit → return immediately; cache miss → install via Disco.
 *   * `ensureJdkForProject(project)` — combine `selectJdkForProject` with
 *     `ensureJdk`. The one call build/test/dev care about.
 *   * `getCachedJdk(major, distribution?)` — look up a cached JDK without
 *     installing. Returns `undefined` on miss.
 *   * `listInstalled()` / `gc(opts)` — used by `pluggy sdk list`/`gc`.
 *
 * Auto-install is on by default. Set `PLUGGY_NO_AUTO_INSTALL=1` to make a
 * cache miss raise instead — CI escape hatch. The error points at the
 * concrete remediation command (`pluggy sdk install <major>`).
 *
 * `JAVA_HOME` is consulted *before* the cache: if it points at a JDK whose
 * major matches what the project needs, that path wins. Lets users keep
 * their existing toolchain (asdf, mise, system-installed) without pluggy
 * downloading a parallel runtime.
 */

import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import process from "node:process";

import { log } from "../logging.ts";
import type { ResolvedProject } from "../project.ts";

import {
  cacheKey,
  forgetEntry,
  javaBinaryPath,
  javaHomePath,
  readManifest,
  recordEntry,
  slotPath,
  touchEntry,
  type CacheKeyParts,
  type ManifestEntry,
} from "./cache.ts";
import { resolveJdk, targetForHost, type DiscoArch, type DiscoOs } from "./disco.ts";
import { installJdk } from "./install.ts";
import { selectJdkForProject, selectJdkForVersion, type ProjectJdkSelection } from "./resolve.ts";

export interface EnsureJdkOptions {
  /** Disco distribution slug. Default `"temurin"`. */
  distribution?: string;
  /**
   * When true, skip the JAVA_HOME short-circuit even if it would match.
   * `pluggy sdk install <major>` sets this — explicit installs always
   * write to the cache, regardless of system Java.
   */
  ignoreSystemJava?: boolean;
}

export interface ResolvedJdk {
  /** Absolute path to `java` (or `java.exe`). */
  javaPath: string;
  /** Absolute path to `javac` (or `javac.exe`). */
  javacPath: string;
  /** Absolute JAVA_HOME (the directory `bin/` lives under). */
  javaHome: string;
  /** Java major release this resolves to. */
  major: number;
  /**
   * Where the JDK came from. `system` = JAVA_HOME; `cache` = previously
   * installed slot; `installed` = freshly downloaded this call.
   */
  source: "system" | "cache" | "installed";
  /** Distribution slug; "system" when sourced from JAVA_HOME. */
  distribution: string;
}

/**
 * Resolve a usable JDK for `major`. Order:
 *   1. JAVA_HOME if its major matches and `ignoreSystemJava` is false.
 *   2. Existing cache slot for (distribution, major, host-os, host-arch).
 *   3. Install via Disco — unless PLUGGY_NO_AUTO_INSTALL is set, in which
 *      case raise with a clear remediation message.
 */
export async function ensureJdk(major: number, opts: EnsureJdkOptions = {}): Promise<ResolvedJdk> {
  if (opts.ignoreSystemJava !== true) {
    const fromEnv = await tryJavaHome(major);
    if (fromEnv !== undefined) return fromEnv;
  }

  const distribution = opts.distribution ?? "temurin";
  const target = targetForHost();
  const parts: CacheKeyParts = {
    distribution,
    major,
    os: target.os,
    arch: target.arch,
  };
  const key = cacheKey(parts);
  const slot = slotPath(key);

  if (existsSync(javaBinaryPath(slot, target.os))) {
    await touchEntry(key);
    return resolvedFromSlot(slot, target.os, parts, "cache");
  }

  if (process.env.PLUGGY_NO_AUTO_INSTALL === "1") {
    throw new Error(
      `sdk: ${distribution} JDK ${major} is not installed and PLUGGY_NO_AUTO_INSTALL=1.\n` +
        `Run: pluggy sdk install ${major}${distribution === "temurin" ? "" : ` --distribution ${distribution}`}`,
    );
  }

  const spec = await resolveJdk({ major, distribution, os: target.os, arch: target.arch });
  await installJdk(spec);
  log.success(`sdk: installed ${distribution} ${spec.fullVersion}`);
  return resolvedFromSlot(slot, target.os, parts, "installed");
}

/**
 * Resolve the JDK for a project — combines `selectJdkForProject` with
 * `ensureJdk`. This is what `build`, `test`, and `dev` call.
 */
export async function ensureJdkForProject(
  project: ResolvedProject,
  opts: EnsureJdkOptions = {},
): Promise<ResolvedJdk & { selection: ProjectJdkSelection }> {
  const selection = await selectJdkForProject(project);
  const distribution = opts.distribution ?? selection.distribution;
  const resolved = await ensureJdk(selection.major, { ...opts, distribution });
  return { ...resolved, selection };
}

/**
 * Resolve the JDK for a specific MC version of a project. Used by matrix
 * callers (the test command) so each `(version, platform)` cell gets the
 * JDK its MC version actually requires — 1.20.4 cells stay on Java 17 even
 * if `versions[0]` is 1.21.
 */
export async function ensureJdkForVersion(
  project: ResolvedProject,
  mcVersion: string | undefined,
  opts: EnsureJdkOptions = {},
): Promise<ResolvedJdk & { selection: ProjectJdkSelection }> {
  const selection = await selectJdkForVersion(project, mcVersion);
  const distribution = opts.distribution ?? selection.distribution;
  const resolved = await ensureJdk(selection.major, { ...opts, distribution });
  return { ...resolved, selection };
}

/**
 * Look up a cached JDK without installing. Returns `undefined` on miss.
 * Used by `pluggy sdk path` and `pluggy sdk list`.
 */
export function getCachedJdk(major: number, distribution = "temurin"): ResolvedJdk | undefined {
  const target = targetForHost();
  const parts: CacheKeyParts = {
    distribution,
    major,
    os: target.os,
    arch: target.arch,
  };
  const key = cacheKey(parts);
  const slot = slotPath(key);
  if (!existsSync(javaBinaryPath(slot, target.os))) return undefined;
  return resolvedFromSlotSync(slot, target.os, parts, "cache");
}

/** Manifest contents in a stable, sorted-by-key form for listings. */
export interface InstalledJdkInfo {
  key: string;
  major: number;
  distribution: string;
  fullVersion: string;
  os: DiscoOs;
  arch: DiscoArch;
  installedAt: number;
  lastUsed: number;
  /** Slot path on disk. Present even when the directory has been deleted out-of-band. */
  slotPath: string;
  /** True iff the slot still exists on disk (i.e. the entry isn't dangling). */
  present: boolean;
}

export async function listInstalled(): Promise<InstalledJdkInfo[]> {
  const manifest = await readManifest();
  const out: InstalledJdkInfo[] = [];
  for (const [key, entry] of Object.entries(manifest.entries)) {
    const slot = slotPath(key);
    out.push({
      key,
      major: entry.major,
      distribution: entry.distribution,
      fullVersion: entry.fullVersion,
      os: entry.os,
      arch: entry.arch,
      installedAt: entry.installedAt,
      lastUsed: entry.lastUsed,
      slotPath: slot,
      present: existsSync(slot),
    });
  }
  out.sort((a, b) => a.key.localeCompare(b.key));
  return out;
}

export interface GcOptions {
  /**
   * Keep the N most-recently-used JDKs per major version. Default 2 — gives
   * users a current and a previous slot per major to roll back between.
   */
  keepLatest?: number;
  /** When true, also remove slots that exist on disk but aren't in the manifest. */
  pruneOrphans?: boolean;
}

export interface GcResult {
  removed: { key: string; reason: "lru" | "orphan" | "dangling" }[];
  kept: string[];
}

/**
 * Evict cached JDKs by LRU per major. Also reconciles manifest vs filesystem:
 *   - `dangling`: manifest entry whose on-disk slot is gone → drop from manifest.
 *   - `orphan`: on-disk slot with no manifest entry → optionally `rm -r`.
 */
export async function gc(opts: GcOptions = {}): Promise<GcResult> {
  const keepLatest = Math.max(1, opts.keepLatest ?? 2);
  const result: GcResult = { removed: [], kept: [] };
  const manifest = await readManifest();

  // Group by major; sort each group by lastUsed desc; keep first N.
  const byMajor = new Map<number, [string, ManifestEntry][]>();
  for (const [key, entry] of Object.entries(manifest.entries)) {
    const slot = slotPath(key);
    if (!existsSync(slot)) {
      await forgetEntry(key);
      result.removed.push({ key, reason: "dangling" });
      continue;
    }
    const list = byMajor.get(entry.major) ?? [];
    list.push([key, entry]);
    byMajor.set(entry.major, list);
  }

  for (const list of byMajor.values()) {
    list.sort((a, b) => b[1].lastUsed - a[1].lastUsed);
    for (let i = 0; i < list.length; i++) {
      const [key] = list[i];
      if (i < keepLatest) {
        result.kept.push(key);
      } else {
        await rm(slotPath(key), { recursive: true, force: true });
        await forgetEntry(key);
        result.removed.push({ key, reason: "lru" });
      }
    }
  }

  if (opts.pruneOrphans === true) {
    // Optional second pass — left for a future PR to keep this one bounded.
  }

  return result;
}

/**
 * Remove a specific JDK by major+distribution. Used by `pluggy sdk remove`.
 * Returns `false` if the slot wasn't installed.
 */
export async function removeJdk(major: number, distribution = "temurin"): Promise<boolean> {
  const target = targetForHost();
  const parts: CacheKeyParts = {
    distribution,
    major,
    os: target.os,
    arch: target.arch,
  };
  const key = cacheKey(parts);
  const slot = slotPath(key);
  const slotExists = existsSync(slot);
  if (slotExists) {
    await rm(slot, { recursive: true, force: true });
  }
  await forgetEntry(key);
  return slotExists;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function tryJavaHome(major: number): Promise<ResolvedJdk | undefined> {
  const javaHome = process.env.JAVA_HOME;
  if (javaHome === undefined || javaHome.length === 0) return undefined;

  const target = targetForHost();
  const javaBin = target.os === "windows" ? "java.exe" : "java";
  const javaPath = join(javaHome, "bin", javaBin);
  if (!existsSync(javaPath)) return undefined;

  let detectedMajor: number | undefined;
  try {
    detectedMajor = await detectJavaMajor(javaPath);
  } catch {
    return undefined;
  }
  if (detectedMajor !== major) return undefined;

  log.debug(`sdk: using JAVA_HOME (Java ${major}) at ${javaHome}`);
  return {
    javaPath,
    javacPath: join(javaHome, "bin", target.os === "windows" ? "javac.exe" : "javac"),
    javaHome,
    major,
    source: "system",
    distribution: "system",
  };
}

async function resolvedFromSlot(
  slot: string,
  os: DiscoOs,
  parts: CacheKeyParts,
  source: "cache" | "installed",
): Promise<ResolvedJdk> {
  const fromManifest = (await readManifest()).entries[cacheKey(parts)];
  if (fromManifest === undefined && source === "installed") {
    // installJdk records the entry — but if a future code path skips that,
    // backfill defensively rather than returning a torn ResolvedJdk.
    await recordEntry(cacheKey(parts), parts, "unknown");
  }
  return resolvedFromSlotSync(slot, os, parts, source);
}

function resolvedFromSlotSync(
  slot: string,
  os: DiscoOs,
  parts: CacheKeyParts,
  source: "cache" | "installed",
): ResolvedJdk {
  return {
    javaPath: javaBinaryPath(slot, os),
    javacPath: join(javaHomePath(slot, os), "bin", os === "windows" ? "javac.exe" : "javac"),
    javaHome: javaHomePath(slot, os),
    major: parts.major,
    source,
    distribution: parts.distribution,
  };
}

/** Spawn `<javaPath> -version` and parse the major release. */
function detectJavaMajor(javaPath: string): Promise<number | undefined> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(javaPath, ["-version"], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (b: Buffer) => {
      stdout += b.toString("utf8");
    });
    child.stderr?.on("data", (b: Buffer) => {
      stderr += b.toString("utf8");
    });
    child.once("error", rejectPromise);
    child.once("exit", (code) => {
      if (code !== 0) {
        resolvePromise(undefined);
        return;
      }
      const combined = `${stdout}\n${stderr}`;
      // Java prints `version "1.8.0_xxx"` (Java 8) or `version "21.0.4"` (>=9).
      const match =
        combined.match(/version "(\d+)(?:\.(\d+))?[^"]*"/) ??
        combined.match(/version (\d+)(?:\.(\d+))?/);
      if (match === null) {
        resolvePromise(undefined);
        return;
      }
      const parsed = Number.parseInt(
        match[1] === "1" && match[2] !== undefined ? match[2] : match[1],
        10,
      );
      resolvePromise(Number.isNaN(parsed) ? undefined : parsed);
    });
  });
}
