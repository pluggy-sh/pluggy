/**
 * Contract tests for the staged-swap install pipeline. No network: the
 * happy path feeds `installJdk` a pre-cached local archive, and the failure
 * paths use an unreachable download URL or a corrupt archive. `getCachePath`
 * is redirected to a tempdir so the user's real pluggy cache is never touched.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

vi.mock("../project.ts", async () => {
  const actual = await vi.importActual<typeof import("../project.ts")>("../project.ts");
  return { ...actual, getCachePath: vi.fn() };
});

import { getCachePath } from "../project.ts";

import { archivePath, cacheKey, readManifest, slotPath } from "./cache.ts";
import type { JdkSpec } from "./disco.ts";
import { installJdk } from "./install.ts";

const execFileAsync = promisify(execFile);

const KEY = cacheKey({ distribution: "temurin", major: 21, os: "linux", arch: "x64" });

function spec(overrides: Partial<JdkSpec> = {}): JdkSpec {
  return {
    distribution: "temurin",
    major: 21,
    fullVersion: "21.0.0+1",
    os: "linux",
    arch: "x64",
    archiveType: "tar.gz",
    downloadUrl: "https://127.0.0.1:1/jdk.tar.gz",
    filename: "jdk.tar.gz",
    ...overrides,
  };
}

/** Write a valid JDK-shaped tar.gz (one top-level dir with bin/java) into the archive cache. */
async function makeArchive(marker: string): Promise<void> {
  const work = await mkdtemp(join(tmpdir(), "pluggy-jdk-work-"));
  try {
    await mkdir(join(work, "jdk-inner", "bin"), { recursive: true });
    await writeFile(join(work, "jdk-inner", "bin", "java"), marker);
    const dest = archivePath(KEY, "tar.gz");
    await mkdir(dirname(dest), { recursive: true });
    await execFileAsync("tar", ["-czf", dest, "-C", work, "jdk-inner"]);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function seedSlot(marker: string): Promise<void> {
  await mkdir(join(slotPath(KEY), "bin"), { recursive: true });
  await writeFile(join(slotPath(KEY), "bin", "java"), marker);
}

describe("installJdk", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "pluggy-sdk-install-"));
    vi.mocked(getCachePath).mockReturnValue(tmp);
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
    vi.mocked(getCachePath).mockReset();
  });

  test("extracts a cached archive into the slot without downloading", async () => {
    await makeArchive("new-jdk");

    const result = await installJdk(spec());

    expect(result.slotRoot).toBe(slotPath(KEY));
    expect(await readFile(result.javaPath, "utf8")).toBe("new-jdk");
    expect((await readManifest()).entries[KEY]?.fullVersion).toBe("21.0.0+1");
  });

  test("replaces an existing slot only after a successful extract", async () => {
    await seedSlot("old-jdk");
    await makeArchive("new-jdk");

    await installJdk(spec());

    expect(await readFile(join(slotPath(KEY), "bin", "java"), "utf8")).toBe("new-jdk");
  });

  test("a failed download leaves the existing slot untouched", async () => {
    await seedSlot("old-jdk");
    await makeArchive("would-be-discarded");

    // freshArchive drops the cached archive, so install must re-download
    // from the unreachable URL and fail before touching the slot.
    await expect(installJdk(spec(), { freshArchive: true })).rejects.toThrow();

    expect(await readFile(join(slotPath(KEY), "bin", "java"), "utf8")).toBe("old-jdk");
    expect(existsSync(archivePath(KEY, "tar.gz"))).toBe(false);
  });

  test("a corrupt archive leaves the existing slot untouched", async () => {
    await seedSlot("old-jdk");
    const archive = archivePath(KEY, "tar.gz");
    await mkdir(dirname(archive), { recursive: true });
    await writeFile(archive, "not a tarball");

    await expect(installJdk(spec())).rejects.toThrow();

    expect(await readFile(join(slotPath(KEY), "bin", "java"), "utf8")).toBe("old-jdk");
  });
});
