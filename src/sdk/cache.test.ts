/**
 * Unit tests for `src/sdk/cache.ts`. Pure path/manifest helpers — no
 * network, no extraction. The manifest tests redirect `getCachePath` to
 * a tempdir per-test so the user's real pluggy cache is never touched.
 */

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

vi.mock("../project.ts", async () => {
  const actual = await vi.importActual<typeof import("../project.ts")>("../project.ts");
  return { ...actual, getCachePath: vi.fn() };
});

import { getCachePath } from "../project.ts";

import {
  cacheKey,
  forgetEntry,
  javaBinaryPath,
  javacBinaryPath,
  javaHomePath,
  jdkCacheRoot,
  readManifest,
  recordEntry,
  slotPath,
  touchEntry,
} from "./cache.ts";

describe("cacheKey", () => {
  test("formats deterministically", () => {
    expect(cacheKey({ distribution: "temurin", major: 21, os: "macos", arch: "aarch64" })).toBe(
      "temurin-21-macos-aarch64",
    );
  });
});

describe("javaBinaryPath / javaHomePath", () => {
  test("linux is flat", () => {
    expect(javaBinaryPath("/cache/temurin-21-linux-x64", "linux")).toBe(
      "/cache/temurin-21-linux-x64/bin/java",
    );
    expect(javaHomePath("/cache/temurin-21-linux-x64", "linux")).toBe(
      "/cache/temurin-21-linux-x64",
    );
  });

  test("windows uses java.exe", () => {
    expect(javaBinaryPath("/cache/temurin-21-windows-x64", "windows")).toBe(
      "/cache/temurin-21-windows-x64/bin/java.exe",
    );
    expect(javacBinaryPath("/cache/temurin-21-windows-x64", "windows")).toBe(
      "/cache/temurin-21-windows-x64/bin/javac.exe",
    );
  });

  test("macos falls back to flat layout when Contents/Home is missing", () => {
    // Without Contents/Home present on disk, javaHomePath returns slotRoot.
    expect(javaBinaryPath("/cache/temurin-21-macos-aarch64", "macos")).toBe(
      "/cache/temurin-21-macos-aarch64/bin/java",
    );
  });
});

describe("manifest read/write/touch", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "pluggy-sdk-cache-"));
    vi.mocked(getCachePath).mockReturnValue(tmp);
    await mkdir(jdkCacheRoot(), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
    vi.mocked(getCachePath).mockReset();
  });

  test("readManifest returns empty entries when file is missing", async () => {
    const m = await readManifest();
    expect(m.entries).toEqual({});
  });

  test("recordEntry writes a fresh entry; readManifest sees it", async () => {
    const parts = { distribution: "temurin", major: 21, os: "linux", arch: "x64" } as const;
    const key = cacheKey(parts);
    await recordEntry(key, parts, "21.0.5+11");
    const m = await readManifest();
    expect(m.entries[key]).toBeDefined();
    expect(m.entries[key].fullVersion).toBe("21.0.5+11");
    expect(m.entries[key].installedAt).toBeGreaterThan(0);
    expect(m.entries[key].lastUsed).toBe(m.entries[key].installedAt);
  });

  test("touchEntry bumps lastUsed", async () => {
    const parts = { distribution: "temurin", major: 21, os: "linux", arch: "x64" } as const;
    const key = cacheKey(parts);
    await recordEntry(key, parts, "21.0.5+11");
    const before = (await readManifest()).entries[key].lastUsed;
    await new Promise((r) => setTimeout(r, 5));
    await touchEntry(key);
    const after = (await readManifest()).entries[key].lastUsed;
    expect(after).toBeGreaterThanOrEqual(before);
  });

  test("touchEntry on missing key is a no-op", async () => {
    await touchEntry("does-not-exist");
    const m = await readManifest();
    expect(m.entries).toEqual({});
  });

  test("forgetEntry removes the entry", async () => {
    const parts = { distribution: "temurin", major: 21, os: "linux", arch: "x64" } as const;
    const key = cacheKey(parts);
    await recordEntry(key, parts, "21.0.5+11");
    await forgetEntry(key);
    const m = await readManifest();
    expect(m.entries[key]).toBeUndefined();
  });

  test("slotPath joins under jdkCacheRoot", () => {
    const key = "temurin-21-linux-x64";
    expect(slotPath(key).startsWith(jdkCacheRoot())).toBe(true);
    expect(slotPath(key).endsWith(key)).toBe(true);
  });
});
