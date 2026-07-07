/**
 * Contract tests for the `pluggy cache clean` guards. `getCachePath` is
 * redirected to a tempdir so the user's real pluggy cache is never touched.
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

import { initLogging } from "../logging.ts";
import { cacheCommand } from "./cache.ts";

async function parse(args: string[]): Promise<void> {
  const cmd = cacheCommand();
  cmd.exitOverride();
  await cmd.parseAsync(args, { from: "user" });
}

describe("cache clean", () => {
  let tmp: string;
  let jarPath: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "pluggy-cache-clean-"));
    vi.mocked(getCachePath).mockReturnValue(tmp);
    jarPath = join(tmp, "versions", "paper-1.21.1-127.jar");
    await mkdir(join(tmp, "versions"), { recursive: true });
    await writeFile(jarPath, "jar-bytes");
    initLogging({ json: false, verbose: false, noColor: true });
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
    vi.mocked(getCachePath).mockReset();
    initLogging({ json: false, verbose: false, noColor: true });
  });

  test("--json without --yes refuses and deletes nothing", async () => {
    initLogging({ json: true, verbose: false, noColor: true });
    await expect(parse(["clean"])).rejects.toThrow(/pass --yes/);
    expect(existsSync(jarPath)).toBe(true);
  });

  test("--dry-run reports without deleting and needs no --yes in --json mode", async () => {
    initLogging({ json: true, verbose: false, noColor: true });
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await parse(["clean", "--dry-run"]);
      const payload = JSON.parse(spy.mock.calls.at(-1)?.[0] as string) as {
        dryRun: boolean;
        wouldRemove: { path: string }[];
        freedBytes: number;
      };
      expect(payload.dryRun).toBe(true);
      expect(payload.wouldRemove.some((e) => e.path === jarPath)).toBe(true);
      expect(payload.freedBytes).toBeGreaterThan(0);
    } finally {
      spy.mockRestore();
    }
    expect(existsSync(jarPath)).toBe(true);
  });

  test("--yes skips the prompt and deletes", async () => {
    await parse(["clean", "--yes"]);
    expect(existsSync(jarPath)).toBe(false);
  });

  test("--json --yes deletes", async () => {
    initLogging({ json: true, verbose: false, noColor: true });
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await parse(["clean", "--yes"]);
    } finally {
      spy.mockRestore();
    }
    expect(existsSync(jarPath)).toBe(false);
  });
});
