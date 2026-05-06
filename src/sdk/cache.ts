/**
 * On-disk layout for cached JDKs and the LRU manifest used by `pluggy cache prune`.
 *
 *   <cachePath>/jdk/
 *     manifest.json                     -- {entries: {<key>: {lastUsed, fullVersion, installedAt}}}
 *     archives/                         -- downloaded tarballs/zips, persisted for re-extract
 *       temurin-21-macos-aarch64.tar.gz
 *     temurin-21-macos-aarch64/         -- extracted JDK; cache slot
 *       Contents/Home/bin/java          -- macOS bundle layout
 *     temurin-21-linux-x64/
 *       bin/java
 *     temurin-21-windows-x64/
 *       bin/java.exe
 *
 * Cache key is `<distribution>-<major>-<os>-<arch>` — major-only on the
 * version axis so reinstalling the same major replaces the slot in place.
 * Point releases are recorded inside the manifest entry's `fullVersion`.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { writeFileLF } from "../portable.ts";
import { getCachePath } from "../project.ts";

import type { DiscoArch, DiscoOs } from "./disco.ts";

const MANIFEST_FILE = "manifest.json";
const ARCHIVES_DIR = "archives";

export interface ManifestEntry {
  /** epoch ms — `ensureJdk` updates this on every cache hit for LRU prune. */
  lastUsed: number;
  /** epoch ms — set when the slot is first populated. */
  installedAt: number;
  /** Full Disco version string (e.g. "21.0.11+10"). */
  fullVersion: string;
  /** Distribution slug snapshot (so callers can list installed JDKs without parsing the key). */
  distribution: string;
  major: number;
  os: DiscoOs;
  arch: DiscoArch;
}

export interface Manifest {
  /** Keyed by `cacheKey` (see below). */
  entries: Record<string, ManifestEntry>;
}

export interface CacheKeyParts {
  distribution: string;
  major: number;
  os: DiscoOs;
  arch: DiscoArch;
}

/** Build the cache key — stable per (distribution, major, os, arch). */
export function cacheKey(parts: CacheKeyParts): string {
  return `${parts.distribution}-${parts.major}-${parts.os}-${parts.arch}`;
}

/** Root directory under the user cache for everything SDK-related. */
export function jdkCacheRoot(): string {
  return join(getCachePath(), "jdk");
}

/** Absolute path to the (possibly non-existent) extracted slot for a key. */
export function slotPath(key: string): string {
  return join(jdkCacheRoot(), key);
}

/** Absolute path where the downloaded archive is staged before extraction. */
export function archivePath(key: string, archiveType: "tar.gz" | "zip"): string {
  return join(jdkCacheRoot(), ARCHIVES_DIR, `${key}.${archiveType}`);
}

/**
 * Resolve the `java` binary inside an extracted JDK. macOS JDKs typically
 * ship as Mac app bundles (`Contents/Home/bin/java`); Linux, Windows, and a
 * few flattened macOS distros are flat (`bin/java`).
 *
 * `slotRoot` is the directory the archive extracted *into* — i.e. our cache
 * slot directory after the install pipeline renamed the inner top-level dir
 * into place.
 */
export function javaBinaryPath(slotRoot: string, os: DiscoOs): string {
  const bin = os === "windows" ? "java.exe" : "java";
  return join(javaHomePath(slotRoot, os), "bin", bin);
}

/** Path to a JDK's $JAVA_HOME (the directory `bin/` lives under). */
export function javaHomePath(slotRoot: string, os: DiscoOs): string {
  if (os === "macos") {
    const bundleHome = join(slotRoot, "Contents", "Home");
    if (existsSync(join(bundleHome, "bin"))) return bundleHome;
  }
  return slotRoot;
}

/** Resolve the `javac` binary alongside `java` — same directory on every layout. */
export function javacBinaryPath(slotRoot: string, os: DiscoOs): string {
  const javacName = os === "windows" ? "javac.exe" : "javac";
  return join(javaHomePath(slotRoot, os), "bin", javacName);
}

/** Read the manifest, tolerating absence (returns an empty manifest). */
export async function readManifest(): Promise<Manifest> {
  const path = join(jdkCacheRoot(), MANIFEST_FILE);
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<Manifest>;
    return { entries: parsed.entries ?? {} };
  } catch {
    return { entries: {} };
  }
}

/** Persist the manifest. Caller is responsible for whatever mutation made sense. */
export async function writeManifest(manifest: Manifest): Promise<void> {
  await mkdir(jdkCacheRoot(), { recursive: true });
  const path = join(jdkCacheRoot(), MANIFEST_FILE);
  await writeFileLF(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

/** Bump `lastUsed` on a cache hit. No-op if the entry is missing. */
export async function touchEntry(key: string): Promise<void> {
  const manifest = await readManifest();
  const entry = manifest.entries[key];
  if (entry === undefined) return;
  entry.lastUsed = Date.now();
  await writeManifest(manifest);
}

/** Record a freshly-installed slot. Overwrites any previous entry for the key. */
export async function recordEntry(
  key: string,
  parts: CacheKeyParts,
  fullVersion: string,
): Promise<void> {
  const manifest = await readManifest();
  const now = Date.now();
  manifest.entries[key] = {
    lastUsed: now,
    installedAt: now,
    fullVersion,
    distribution: parts.distribution,
    major: parts.major,
    os: parts.os,
    arch: parts.arch,
  };
  await writeManifest(manifest);
}

/** Drop a cache entry from the manifest. Caller deletes the on-disk slot. */
export async function forgetEntry(key: string): Promise<void> {
  const manifest = await readManifest();
  if (!(key in manifest.entries)) return;
  delete manifest.entries[key];
  await writeManifest(manifest);
}

/** Ensure the cache root and archives subdir exist for downstream writes. */
export async function ensureCacheDirs(): Promise<void> {
  await mkdir(join(jdkCacheRoot(), ARCHIVES_DIR), { recursive: true });
}
