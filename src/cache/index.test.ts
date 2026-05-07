/**
 * Tests for the cache module. Each test redirects `getCachePath` (and where
 * relevant `getStatePath`) to a tempdir so the user's real pluggy cache is
 * never touched.
 */

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

vi.mock("../project.ts", async () => {
  const actual = await vi.importActual<typeof import("../project.ts")>("../project.ts");
  return { ...actual, getCachePath: vi.fn() };
});

import { getCachePath } from "../project.ts";
import { recordEntry, jdkCacheRoot, slotPath } from "../sdk/cache.ts";

import {
  cleanCache,
  formatBytes,
  isCategoryId,
  listCacheEntries,
  parseDurationMs,
  parseSizeBytes,
  pruneCache,
  scanCache,
} from "./index.ts";

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "pluggy-cache-test-"));
  vi.mocked(getCachePath).mockReturnValue(tmp);
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
  vi.mocked(getCachePath).mockReset();
});

async function writeFixture(relPath: string, bytes: number, mtimeMs?: number): Promise<string> {
  const full = join(tmp, relPath);
  await mkdir(join(full, ".."), { recursive: true });
  await writeFile(full, Buffer.alloc(bytes, "x"));
  if (mtimeMs !== undefined) {
    const seconds = mtimeMs / 1000;
    await utimes(full, seconds, seconds);
  }
  return full;
}

async function writeJdkSlot(key: string, fullVersion: string, lastUsed: number): Promise<void> {
  const root = jdkCacheRoot();
  await mkdir(slotPath(key), { recursive: true });
  await writeFile(join(slotPath(key), "marker"), Buffer.alloc(1024, "j"));
  // Distribution-major-os-arch parse — pretend Linux x64 21.
  await mkdir(root, { recursive: true });
  const parts = key.split("-");
  await recordEntry(
    key,
    {
      distribution: parts[0],
      major: Number.parseInt(parts[1], 10),
      os: parts[2] as "linux",
      arch: parts[3] as "x64",
    },
    fullVersion,
  );
  // Backdate manifest lastUsed by rewriting it.
  const manifestPath = join(root, "manifest.json");
  const raw = await import("node:fs/promises").then((m) => m.readFile(manifestPath, "utf8"));
  const parsed = JSON.parse(raw);
  parsed.entries[key].lastUsed = lastUsed;
  await writeFile(manifestPath, JSON.stringify(parsed, null, 2));
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("formatBytes", () => {
  test("scales B / KB / MB / GB", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toMatch(/^2\.0 KB$/);
    expect(formatBytes(5 * 1024 * 1024)).toMatch(/^5\.00 MB$/);
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toMatch(/^3\.00 GB$/);
  });
});

describe("parseDurationMs", () => {
  test("parses every supported suffix", () => {
    expect(parseDurationMs("30s")).toBe(30_000);
    expect(parseDurationMs("5m")).toBe(5 * 60_000);
    expect(parseDurationMs("12h")).toBe(12 * 3_600_000);
    expect(parseDurationMs("90d")).toBe(90 * 86_400_000);
    expect(parseDurationMs("2w")).toBe(14 * 86_400_000);
  });
  test("unsuffixed values are days", () => {
    expect(parseDurationMs("7")).toBe(7 * 86_400_000);
  });
  test("rejects malformed input", () => {
    expect(() => parseDurationMs("forever")).toThrow();
    expect(() => parseDurationMs("-1d")).toThrow();
  });
});

describe("parseSizeBytes", () => {
  test("scales K/M/G/T (and *B forms)", () => {
    expect(parseSizeBytes("1024")).toBe(1024);
    expect(parseSizeBytes("2K")).toBe(2 * 1024);
    expect(parseSizeBytes("5M")).toBe(5 * 1024 ** 2);
    expect(parseSizeBytes("3GB")).toBe(3 * 1024 ** 3);
    expect(parseSizeBytes("1T")).toBe(1024 ** 4);
  });
  test("rejects malformed input", () => {
    expect(() => parseSizeBytes("big")).toThrow();
  });
});

describe("isCategoryId", () => {
  test("accepts each known id and rejects others", () => {
    for (const id of ["jdk", "versions", "buildtools", "dependencies", "jbr", "hotswap"]) {
      expect(isCategoryId(id)).toBe(true);
    }
    expect(isCategoryId("update-check")).toBe(false);
    expect(isCategoryId("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// scanCache
// ---------------------------------------------------------------------------

describe("scanCache", () => {
  test("returns zeroed categories on an empty cache", async () => {
    const summary = await scanCache();
    expect(summary.cachePath).toBe(tmp);
    expect(summary.totalBytes).toBe(0);
    expect(summary.categories.jdk).toEqual({ entries: 0, bytes: 0 });
    expect(summary.categories.dependencies.maven).toEqual({ entries: 0, bytes: 0 });
  });

  test("aggregates sizes across every category", async () => {
    await writeFixture("versions/paper-1.21.1-127.jar", 1000);
    await writeFixture("BuildTools.jar", 2000);
    await writeFixture("BuildTools/spigot-1.21.1.jar", 500);
    await writeFixture("dependencies/maven/net.kyori/adventure-api/4.18.0.jar", 100);
    await writeFixture("dependencies/modrinth/worldedit/1.5.0.jar", 200);
    await writeFixture("dependencies/file/abc123.jar", 50);
    await writeFixture("agents/hotswap-agent-2.0.3.jar", 300);
    await writeFixture("jbr/some-archive.tar.gz", 700);
    await writeJdkSlot("temurin-21-linux-x64", "21.0.5+11", Date.now());

    const summary = await scanCache();
    expect(summary.categories.versions).toEqual({ entries: 1, bytes: 1000 });
    expect(summary.categories.buildtools.entries).toBe(2);
    expect(summary.categories.buildtools.bytes).toBe(2500);
    expect(summary.categories.dependencies.maven).toEqual({ entries: 1, bytes: 100 });
    expect(summary.categories.dependencies.modrinth).toEqual({ entries: 1, bytes: 200 });
    expect(summary.categories.dependencies.file).toEqual({ entries: 1, bytes: 50 });
    expect(summary.categories.dependencies.entries).toBe(3);
    expect(summary.categories.dependencies.bytes).toBe(350);
    expect(summary.categories.hotswap).toEqual({ entries: 1, bytes: 300 });
    expect(summary.categories.jbr).toEqual({ entries: 1, bytes: 700 });
    expect(summary.categories.jdk.entries).toBe(1);
    expect(summary.totalBytes).toBe(1000 + 2500 + 350 + 300 + 700 + summary.categories.jdk.bytes);
  });
});

// ---------------------------------------------------------------------------
// listCacheEntries
// ---------------------------------------------------------------------------

describe("listCacheEntries", () => {
  test("scopes to a single category", async () => {
    await writeFixture("versions/paper-1.21.1-127.jar", 100);
    await writeFixture("dependencies/maven/g/a/1.0.0.jar", 200);
    const groups = await listCacheEntries("versions");
    expect(groups).toHaveLength(1);
    expect(groups[0].category).toBe("versions");
    expect(groups[0].entries[0].id).toBe("paper-1.21.1-127.jar");
  });

  test("formats dependency identifiers with subcategory", async () => {
    await writeFixture("dependencies/maven/net.kyori/adventure-api/4.18.0.jar", 100);
    const [group] = await listCacheEntries("dependencies");
    expect(group.entries[0].id).toBe("net.kyori:adventure-api:4.18.0");
    expect(group.entries[0].subcategory).toBe("maven");
  });
});

// ---------------------------------------------------------------------------
// cleanCache
// ---------------------------------------------------------------------------

describe("cleanCache", () => {
  test("scoped clean removes only the requested category", async () => {
    const versionPath = await writeFixture("versions/paper.jar", 100);
    const depPath = await writeFixture("dependencies/maven/g/a/1.0.jar", 200);
    const result = await cleanCache("versions");
    expect(result.removed).toHaveLength(1);
    expect(result.freedBytes).toBe(100);
    expect(existsSync(versionPath)).toBe(false);
    expect(existsSync(depPath)).toBe(true);
  });

  test("category=all wipes everything pluggy tracks", async () => {
    await writeFixture("versions/paper.jar", 100);
    await writeFixture("dependencies/maven/g/a/1.0.jar", 200);
    await writeFixture("agents/hotswap-agent-2.0.3.jar", 50);
    await writeJdkSlot("temurin-21-linux-x64", "21.0.5+11", Date.now());
    const result = await cleanCache("all");
    expect(result.removed.length).toBeGreaterThanOrEqual(4);
    expect(result.freedBytes).toBeGreaterThan(350);
    // JDK manifest entry should be reconciled away too.
    const summary = await scanCache();
    expect(summary.categories.jdk.entries).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// pruneCache
// ---------------------------------------------------------------------------

describe("pruneCache", () => {
  test("max-age removes anything older than the cutoff", async () => {
    const fresh = await writeFixture("versions/fresh.jar", 100, Date.now());
    const stale = await writeFixture("versions/stale.jar", 100, Date.now() - 100 * 86_400_000);
    const result = await pruneCache({ maxAgeMs: 90 * 86_400_000 });
    expect(result.removed).toHaveLength(1);
    expect(result.removed[0].path).toBe(stale);
    expect(result.removed[0].reason).toBe("age");
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(stale)).toBe(false);
  });

  test("max-size evicts oldest until under budget", async () => {
    const now = Date.now();
    await writeFixture("versions/a.jar", 1000, now - 3 * 86_400_000);
    await writeFixture("versions/b.jar", 1000, now - 2 * 86_400_000);
    await writeFixture("versions/c.jar", 1000, now - 1 * 86_400_000);
    const result = await pruneCache({
      maxAgeMs: 0,
      maxBytes: 1500,
      category: "versions",
    });
    // Should evict the two oldest (a, then b) leaving 1000 bytes.
    const removedNames = result.removed.map((r) => r.id).sort();
    expect(removedNames).toEqual(["a.jar", "b.jar"]);
    for (const r of result.removed) expect(r.reason).toBe("size");
  });

  test("keep-latest pins the N most-recent JDKs per major", async () => {
    const now = Date.now();
    await writeJdkSlot("temurin-21-linux-x64", "21.0.5+11", now);
    await writeJdkSlot("zulu-21-linux-x64", "21.0.4", now - 1000);
    await writeJdkSlot("liberica-21-linux-x64", "21.0.3", now - 2000);
    const result = await pruneCache({
      maxAgeMs: 0,
      keepLatest: 2,
      category: "jdk",
    });
    const evicted = result.removed
      .filter((r) => r.reason !== "dangling")
      .map((r) => r.id)
      .sort();
    expect(evicted).toEqual(["liberica-21-linux-x64"]);
    expect(existsSync(slotPath("temurin-21-linux-x64"))).toBe(true);
    expect(existsSync(slotPath("zulu-21-linux-x64"))).toBe(true);
    expect(existsSync(slotPath("liberica-21-linux-x64"))).toBe(false);
  });

  test("keep-latest 0 opts out of the LRU pin so age/size handles JDKs", async () => {
    const now = Date.now();
    await writeJdkSlot("temurin-21-linux-x64", "21.0.5+11", now);
    await writeJdkSlot("zulu-21-linux-x64", "21.0.4", now - 1000);
    await writeJdkSlot("liberica-21-linux-x64", "21.0.3", now - 2000);
    const result = await pruneCache({
      maxAgeMs: 0,
      keepLatest: 0,
      category: "jdk",
    });
    expect(result.removed.filter((r) => r.reason === "lru")).toHaveLength(0);
    expect(existsSync(slotPath("temurin-21-linux-x64"))).toBe(true);
    expect(existsSync(slotPath("zulu-21-linux-x64"))).toBe(true);
    expect(existsSync(slotPath("liberica-21-linux-x64"))).toBe(true);
  });

  test("dry-run reports what would be removed without touching disk", async () => {
    const stale = await writeFixture("versions/stale.jar", 100, Date.now() - 100 * 86_400_000);
    const result = await pruneCache({
      maxAgeMs: 90 * 86_400_000,
      dryRun: true,
    });
    expect(result.dryRun).toBe(true);
    expect(result.removed).toHaveLength(1);
    expect(existsSync(stale)).toBe(true);
  });
});
