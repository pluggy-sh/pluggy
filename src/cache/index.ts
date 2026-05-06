/**
 * `pluggy cache` core. Pure scan/clean/prune logic; the CLI surface in
 * `src/commands/cache.ts` is a thin wrapper. Other modules own how they
 * *populate* the cache (resolvers, platform providers, the SDK installer,
 * the dev runner); this module knows how to *introspect and reclaim* it.
 *
 * On-disk layout under `getCachePath()`:
 *
 *   jdk/                              -- managed JDKs (LRU manifest)
 *     manifest.json
 *     archives/                       -- downloaded tarballs/zips
 *     <distribution>-<major>-<os>-<arch>/
 *   versions/                         -- platform server jars
 *     paper-1.21.1-127.jar
 *   BuildTools.jar                    -- Spigot BuildTools driver
 *   BuildTools/                       -- BuildTools output cache
 *     spigot-1.21.1.jar
 *   dependencies/
 *     maven/<groupId>/<artifactId>/<version>.jar
 *     modrinth/<slug>/<version>.jar
 *     file/<sha256>.jar
 *   jbr/                              -- JetBrains Runtime for hotswap
 *     <key>/                          -- extracted slot
 *     jbr_*.tar.gz                    -- archive
 *   agents/                           -- HotswapAgent jars
 *     hotswap-agent-<version>.jar
 */

import { existsSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { getCachePath } from "../project.ts";
import { forgetEntry, jdkCacheRoot, readManifest, slotPath } from "../sdk/cache.ts";

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

export type CategoryId = "jdk" | "versions" | "buildtools" | "dependencies" | "jbr" | "hotswap";

export const CATEGORY_IDS: readonly CategoryId[] = [
  "jdk",
  "versions",
  "buildtools",
  "dependencies",
  "jbr",
  "hotswap",
] as const;

export interface CategorySummary {
  entries: number;
  bytes: number;
}

export interface DependencySummary {
  entries: number;
  bytes: number;
  maven: CategorySummary;
  modrinth: CategorySummary;
  file: CategorySummary;
}

export interface CacheSummary {
  cachePath: string;
  totalBytes: number;
  categories: {
    jdk: CategorySummary;
    versions: CategorySummary;
    buildtools: CategorySummary;
    dependencies: DependencySummary;
    jbr: CategorySummary;
    hotswap: CategorySummary;
  };
}

export interface CacheEntry {
  /** Stable identifier used in CLI output and JSON. Unique within its category. */
  id: string;
  /** Absolute path on disk — may be a file or a directory. */
  path: string;
  /** Total bytes, recursive for directories. */
  bytes: number;
  /** Epoch ms of most recent activity. JDKs use manifest `lastUsed`; everything else uses mtime. */
  lastUsedMs: number;
  /** Sub-bucket key (e.g. `"maven"` for dependencies). Optional. */
  subcategory?: string;
}

export interface CategoryEntries {
  category: CategoryId;
  entries: CacheEntry[];
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

/**
 * Walk the cache and aggregate sizes by category. Cheap to call: it
 * `stat`s every file but never reads contents.
 */
export async function scanCache(): Promise<CacheSummary> {
  const root = getCachePath();
  const all = await Promise.all([
    listJdkEntries(),
    listVersionsEntries(),
    listBuildtoolsEntries(),
    listDependenciesEntries(),
    listJbrEntries(),
    listHotswapEntries(),
  ]);
  const [jdk, versions, buildtools, deps, jbr, hotswap] = all;

  const summarize = (entries: CacheEntry[]): CategorySummary => ({
    entries: entries.length,
    bytes: entries.reduce((acc, e) => acc + e.bytes, 0),
  });

  const summarizeBy = (entries: CacheEntry[], sub: string): CategorySummary =>
    summarize(entries.filter((e) => e.subcategory === sub));

  const dependencies: DependencySummary = {
    ...summarize(deps),
    maven: summarizeBy(deps, "maven"),
    modrinth: summarizeBy(deps, "modrinth"),
    file: summarizeBy(deps, "file"),
  };

  const totalBytes =
    summarize(jdk).bytes +
    summarize(versions).bytes +
    summarize(buildtools).bytes +
    dependencies.bytes +
    summarize(jbr).bytes +
    summarize(hotswap).bytes;

  return {
    cachePath: root,
    totalBytes,
    categories: {
      jdk: summarize(jdk),
      versions: summarize(versions),
      buildtools: summarize(buildtools),
      dependencies,
      jbr: summarize(jbr),
      hotswap: summarize(hotswap),
    },
  };
}

/** Per-entry listing for `pluggy cache list`. Empty array for a category that has no on-disk presence. */
export async function listCacheEntries(category: CategoryId | "all"): Promise<CategoryEntries[]> {
  const wanted: CategoryId[] = category === "all" ? [...CATEGORY_IDS] : [category];
  const out: CategoryEntries[] = [];
  for (const id of wanted) {
    const entries = await loadCategory(id);
    out.push({ category: id, entries });
  }
  return out;
}

async function loadCategory(id: CategoryId): Promise<CacheEntry[]> {
  switch (id) {
    case "jdk":
      return listJdkEntries();
    case "versions":
      return listVersionsEntries();
    case "buildtools":
      return listBuildtoolsEntries();
    case "dependencies":
      return listDependenciesEntries();
    case "jbr":
      return listJbrEntries();
    case "hotswap":
      return listHotswapEntries();
  }
}

async function listJdkEntries(): Promise<CacheEntry[]> {
  const out: CacheEntry[] = [];
  const manifest = await readManifest();
  for (const [key, entry] of Object.entries(manifest.entries)) {
    const slot = slotPath(key);
    if (!existsSync(slot)) continue;
    out.push({
      id: key,
      path: slot,
      bytes: await dirSize(slot),
      lastUsedMs: entry.lastUsed,
    });
  }
  // Archives staged for re-extract sit beside the slots; bill them to the JDK total.
  const archivesDir = join(jdkCacheRoot(), "archives");
  if (existsSync(archivesDir)) {
    for (const file of await listFiles(archivesDir)) {
      out.push({
        id: `archives/${file.name}`,
        path: file.path,
        bytes: file.bytes,
        lastUsedMs: file.mtimeMs,
      });
    }
  }
  return out;
}

async function listVersionsEntries(): Promise<CacheEntry[]> {
  const dir = join(getCachePath(), "versions");
  if (!existsSync(dir)) return [];
  const files = await listFiles(dir);
  return files.map((f) => ({
    id: f.name,
    path: f.path,
    bytes: f.bytes,
    lastUsedMs: f.mtimeMs,
  }));
}

async function listBuildtoolsEntries(): Promise<CacheEntry[]> {
  const out: CacheEntry[] = [];
  const root = getCachePath();
  const driverPath = join(root, "BuildTools.jar");
  if (existsSync(driverPath)) {
    const s = await stat(driverPath);
    out.push({
      id: "BuildTools.jar",
      path: driverPath,
      bytes: s.size,
      lastUsedMs: s.mtimeMs,
    });
  }
  const outputDir = join(root, "BuildTools");
  if (existsSync(outputDir)) {
    // The output dir is large (work tree + jars). Bill it as one entry — users
    // who want a finer view can drop into the directory themselves.
    const s = await stat(outputDir);
    out.push({
      id: "BuildTools/",
      path: outputDir,
      bytes: await dirSize(outputDir),
      lastUsedMs: s.mtimeMs,
    });
  }
  return out;
}

async function listDependenciesEntries(): Promise<CacheEntry[]> {
  const out: CacheEntry[] = [];
  const base = join(getCachePath(), "dependencies");
  if (!existsSync(base)) return out;

  // maven: <base>/maven/<groupId>/<artifactId>/<version>.jar
  const mavenRoot = join(base, "maven");
  if (existsSync(mavenRoot)) {
    for (const groupId of await safeReaddir(mavenRoot)) {
      const groupDir = join(mavenRoot, groupId);
      for (const artifactId of await safeReaddir(groupDir)) {
        const artifactDir = join(groupDir, artifactId);
        for (const file of await listFiles(artifactDir)) {
          if (!file.name.endsWith(".jar")) continue;
          out.push({
            id: `${groupId}:${artifactId}:${file.name.slice(0, -".jar".length)}`,
            path: file.path,
            bytes: file.bytes,
            lastUsedMs: file.mtimeMs,
            subcategory: "maven",
          });
        }
      }
    }
  }

  // modrinth: <base>/modrinth/<slug>/<version>.jar
  const modrinthRoot = join(base, "modrinth");
  if (existsSync(modrinthRoot)) {
    for (const slug of await safeReaddir(modrinthRoot)) {
      const slugDir = join(modrinthRoot, slug);
      for (const file of await listFiles(slugDir)) {
        if (!file.name.endsWith(".jar")) continue;
        out.push({
          id: `${slug}@${file.name.slice(0, -".jar".length)}`,
          path: file.path,
          bytes: file.bytes,
          lastUsedMs: file.mtimeMs,
          subcategory: "modrinth",
        });
      }
    }
  }

  // file: <base>/file/<sha256>.jar
  const fileRoot = join(base, "file");
  if (existsSync(fileRoot)) {
    for (const file of await listFiles(fileRoot)) {
      if (!file.name.endsWith(".jar")) continue;
      out.push({
        id: file.name,
        path: file.path,
        bytes: file.bytes,
        lastUsedMs: file.mtimeMs,
        subcategory: "file",
      });
    }
  }

  return out;
}

async function listJbrEntries(): Promise<CacheEntry[]> {
  const root = join(getCachePath(), "jbr");
  if (!existsSync(root)) return [];
  const out: CacheEntry[] = [];
  for (const name of await safeReaddir(root)) {
    const path = join(root, name);
    const s = await stat(path).catch(() => undefined);
    if (s === undefined) continue;
    out.push({
      id: name,
      path,
      bytes: s.isDirectory() ? await dirSize(path) : s.size,
      lastUsedMs: s.mtimeMs,
    });
  }
  return out;
}

async function listHotswapEntries(): Promise<CacheEntry[]> {
  const dir = join(getCachePath(), "agents");
  if (!existsSync(dir)) return [];
  const files = await listFiles(dir);
  return files.map((f) => ({
    id: f.name,
    path: f.path,
    bytes: f.bytes,
    lastUsedMs: f.mtimeMs,
  }));
}

// ---------------------------------------------------------------------------
// Clean (delete a whole category, or everything)
// ---------------------------------------------------------------------------

export interface CleanResult {
  removed: { id: string; path: string; bytes: number; category: CategoryId }[];
  freedBytes: number;
}

/**
 * Wholesale wipe of a category — delete every entry pluggy knows about under it.
 * `all` wipes every category. JDKs are removed via the manifest so dangling
 * entries don't get left behind.
 */
export async function cleanCache(category: CategoryId | "all"): Promise<CleanResult> {
  const wanted: CategoryId[] = category === "all" ? [...CATEGORY_IDS] : [category];
  const removed: CleanResult["removed"] = [];
  for (const id of wanted) {
    const entries = await loadCategory(id);
    for (const entry of entries) {
      await deleteEntry(id, entry);
      removed.push({ id: entry.id, path: entry.path, bytes: entry.bytes, category: id });
    }
    // After removing all JDK slots, drop their manifest entries so subsequent
    // `cache info` calls don't show ghost numbers from a stale manifest.
    if (id === "jdk") {
      const manifest = await readManifest();
      for (const key of Object.keys(manifest.entries)) await forgetEntry(key);
    }
  }
  return {
    removed,
    freedBytes: removed.reduce((acc, r) => acc + r.bytes, 0),
  };
}

async function deleteEntry(category: CategoryId, entry: CacheEntry): Promise<void> {
  // Match the on-disk shape: JDK slots and BuildTools/ are directories, the
  // rest are files. `rm` with `recursive: true` handles both safely.
  await rm(entry.path, { recursive: true, force: true });
  if (category === "jdk" && !entry.id.startsWith("archives/")) {
    await forgetEntry(entry.id);
  }
}

// ---------------------------------------------------------------------------
// Prune (budget-driven LRU eviction)
// ---------------------------------------------------------------------------

export interface PruneOptions {
  /**
   * Drop entries whose `lastUsedMs` (JDKs) or mtime (everything else) is
   * older than `now - maxAgeMs`. `0` disables age-based pruning.
   */
  maxAgeMs?: number;
  /**
   * After age-based pruning, evict additional entries oldest-first until the
   * scoped total is at or below this byte budget. `undefined` disables the
   * size cap.
   */
  maxBytes?: number;
  /**
   * JDK-only hard cap: keep the N most-recently-used JDKs per major; evict
   * anything beyond that with reason `"lru"`, regardless of age. Defaults
   * to 2 (a current and a previous slot per major).
   */
  keepLatest?: number;
  /** Limit pruning to a single category. Default: every category. */
  category?: CategoryId | "all";
  /** When true, compute what would be removed but don't touch disk. */
  dryRun?: boolean;
  /** Override `Date.now()` for tests. */
  now?: () => number;
}

export interface PruneResult {
  removed: {
    id: string;
    path: string;
    bytes: number;
    category: CategoryId;
    reason: "age" | "size" | "lru" | "dangling";
  }[];
  kept: { id: string; category: CategoryId }[];
  freedBytes: number;
  dryRun: boolean;
}

/**
 * Evict cache entries by per-major LRU (JDKs), age, then size budget.
 * Order of operations per category:
 *   1. JDKs only: reconcile manifests (drop dangling entries) and apply
 *      `keepLatest` as a hard cap — anything beyond the top N per major
 *      is evicted with reason `"lru"`.
 *   2. Apply `maxAgeMs` to whatever survived step 1.
 *   3. Apply `maxBytes` (oldest-first) to whatever's left.
 */
export async function pruneCache(opts: PruneOptions = {}): Promise<PruneResult> {
  const now = opts.now ?? (() => Date.now());
  const dryRun = opts.dryRun === true;
  const keepLatest = Math.max(0, opts.keepLatest ?? 2);
  const maxAgeMs = opts.maxAgeMs ?? 0;
  const maxBytes = opts.maxBytes;
  const wanted: CategoryId[] =
    opts.category === undefined || opts.category === "all" ? [...CATEGORY_IDS] : [opts.category];

  const result: PruneResult = { removed: [], kept: [], freedBytes: 0, dryRun };

  for (const id of wanted) {
    const entries = await loadCategory(id);
    let survivors: CacheEntry[] = entries;

    if (id === "jdk") {
      // Drop manifest entries whose slot vanished out-of-band.
      const manifest = await readManifest();
      for (const [key] of Object.entries(manifest.entries)) {
        if (!existsSync(slotPath(key))) {
          if (!dryRun) await forgetEntry(key);
          result.removed.push({
            id: key,
            path: slotPath(key),
            bytes: 0,
            category: id,
            reason: "dangling",
          });
        }
      }
      // Hard cap: keep only the N most-recently-used slots per major.
      // Archive tarballs (`archives/...`) aren't slot-keyed; they age out
      // through `maxAgeMs` / `maxBytes` instead.
      const byMajor = new Map<number, CacheEntry[]>();
      const unmajored: CacheEntry[] = [];
      for (const entry of entries) {
        const major = parseMajorFromKey(entry.id);
        if (major === undefined) {
          unmajored.push(entry);
          continue;
        }
        const list = byMajor.get(major) ?? [];
        list.push(entry);
        byMajor.set(major, list);
      }
      const kept: CacheEntry[] = [...unmajored];
      for (const list of byMajor.values()) {
        list.sort((a, b) => b.lastUsedMs - a.lastUsedMs);
        for (let i = 0; i < list.length; i++) {
          if (i < keepLatest) {
            kept.push(list[i]);
          } else {
            if (!dryRun) await deleteEntry(id, list[i]);
            result.removed.push({
              id: list[i].id,
              path: list[i].path,
              bytes: list[i].bytes,
              category: id,
              reason: "lru",
            });
          }
        }
      }
      survivors = kept;
    }

    const ageCutoff = maxAgeMs > 0 ? now() - maxAgeMs : -Infinity;
    const afterAge: CacheEntry[] = [];

    for (const entry of survivors) {
      if (entry.lastUsedMs < ageCutoff) {
        if (!dryRun) await deleteEntry(id, entry);
        result.removed.push({
          id: entry.id,
          path: entry.path,
          bytes: entry.bytes,
          category: id,
          reason: "age",
        });
        continue;
      }
      afterAge.push(entry);
    }

    if (maxBytes !== undefined) {
      afterAge.sort((a, b) => a.lastUsedMs - b.lastUsedMs);
      let total = afterAge.reduce((acc, e) => acc + e.bytes, 0);
      while (total > maxBytes && afterAge.length > 0) {
        const victim = afterAge.shift();
        if (victim === undefined) break;
        if (!dryRun) await deleteEntry(id, victim);
        result.removed.push({
          id: victim.id,
          path: victim.path,
          bytes: victim.bytes,
          category: id,
          reason: "size",
        });
        total -= victim.bytes;
      }
    }

    for (const survivor of afterAge) {
      result.kept.push({ id: survivor.id, category: id });
    }
  }

  result.freedBytes = result.removed.reduce((acc, r) => acc + r.bytes, 0);
  return result;
}

/**
 * Pull the major release number out of a JDK cache key like
 * `temurin-21-macos-aarch64`. Returns `undefined` for archive entries
 * (e.g. `archives/temurin-21-macos-aarch64.tar.gz`) or unrecognized shapes.
 */
function parseMajorFromKey(key: string): number | undefined {
  if (key.includes("/")) return undefined;
  const parts = key.split("-");
  if (parts.length < 4) return undefined;
  const n = Number.parseInt(parts[1], 10);
  return Number.isFinite(n) ? n : undefined;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface FileInfo {
  name: string;
  path: string;
  bytes: number;
  mtimeMs: number;
}

async function listFiles(dir: string): Promise<FileInfo[]> {
  const out: FileInfo[] = [];
  for (const name of await safeReaddir(dir)) {
    const path = join(dir, name);
    const s = await stat(path).catch(() => undefined);
    if (s === undefined || !s.isFile()) continue;
    out.push({ name, path, bytes: s.size, mtimeMs: s.mtimeMs });
  }
  return out;
}

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

/** Recursive directory size in bytes. Skips unreadable entries silently. */
export async function dirSize(path: string): Promise<number> {
  let total = 0;
  async function walk(current: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        try {
          const s = await stat(full);
          total += s.size;
        } catch {
          // unreadable entry — ignore
        }
      }
    }
  }
  await walk(path);
  return total;
}

/** Format bytes as a short human string. Mirrors the doctor command's format. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Parse a duration string like `90d`, `12h`, `30m`, `7w` into milliseconds.
 * Unsuffixed integers are read as days. Throws on negative or malformed input.
 */
export function parseDurationMs(value: string): number {
  const m = value.trim().match(/^(\d+)\s*(s|m|h|d|w)?$/);
  if (m === null) throw new Error(`invalid duration "${value}" (expected e.g. 90d, 12h, 30m, 1w)`);
  const n = Number.parseInt(m[1], 10);
  const unit = m[2] ?? "d";
  const ms =
    unit === "s"
      ? 1_000
      : unit === "m"
        ? 60_000
        : unit === "h"
          ? 3_600_000
          : unit === "w"
            ? 7 * 86_400_000
            : 86_400_000;
  return n * ms;
}

/**
 * Parse a size string like `5G`, `500M`, `1024K`, `2048` into bytes.
 * Unsuffixed integers are bytes. Accepts both `G` and `GB` style suffixes.
 */
export function parseSizeBytes(value: string): number {
  const m = value
    .trim()
    .toUpperCase()
    .match(/^(\d+)\s*(B|K|KB|M|MB|G|GB|T|TB)?$/);
  if (m === null) throw new Error(`invalid size "${value}" (expected e.g. 5G, 500M, 1024K)`);
  const n = Number.parseInt(m[1], 10);
  const unit = m[2] ?? "B";
  const factor =
    unit === "B"
      ? 1
      : unit === "K" || unit === "KB"
        ? 1024
        : unit === "M" || unit === "MB"
          ? 1024 ** 2
          : unit === "G" || unit === "GB"
            ? 1024 ** 3
            : 1024 ** 4;
  return n * factor;
}

export function isCategoryId(value: string): value is CategoryId {
  return (CATEGORY_IDS as readonly string[]).includes(value);
}
