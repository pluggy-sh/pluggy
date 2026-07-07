/**
 * Tests for the SDK orchestration layer's cache-mutating pieces. Redirects
 * `getCachePath` to a tempdir so the user's real pluggy cache is never touched.
 */

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

vi.mock("../project.ts", async () => {
  const actual = await vi.importActual<typeof import("../project.ts")>("../project.ts");
  return { ...actual, getCachePath: vi.fn() };
});

import { getCachePath } from "../project.ts";

import { cacheKey, readManifest, recordEntry, slotPath } from "./cache.ts";
import { targetForHost } from "./disco.ts";
import { removeJdk } from "./index.ts";

describe("removeJdk", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "pluggy-sdk-index-"));
    vi.mocked(getCachePath).mockReturnValue(tmp);
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
    vi.mocked(getCachePath).mockReset();
  });

  test("reports the slot path and freed bytes for an installed JDK", async () => {
    const { os, arch } = targetForHost();
    const parts = { distribution: "temurin", major: 21, os, arch };
    const key = cacheKey(parts);
    await recordEntry(key, parts, "21.0.0+1");
    await mkdir(join(slotPath(key), "bin"), { recursive: true });
    await writeFile(join(slotPath(key), "bin", "java"), "0123456789");

    const res = await removeJdk(21, "temurin");

    expect(res.removed).toBe(true);
    expect(res.slotPath).toBe(slotPath(key));
    expect(res.freedBytes).toBe(10);
    expect(existsSync(slotPath(key))).toBe(false);
    expect((await readManifest()).entries[key]).toBeUndefined();
  });

  test("reports removed:false and 0 bytes when nothing was installed", async () => {
    const res = await removeJdk(22, "temurin");
    expect(res.removed).toBe(false);
    expect(res.freedBytes).toBe(0);
    expect(res.slotPath.length).toBeGreaterThan(0);
  });
});
