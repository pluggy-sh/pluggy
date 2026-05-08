import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import { compareVersions, getCachedLatestVersion, startUpdateCheck } from "./update-check.ts";

describe("compareVersions", () => {
  test("equal versions", () => {
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("v1.2.3", "1.2.3")).toBe(0);
  });

  test("less / greater", () => {
    expect(compareVersions("1.2.3", "1.2.4")).toBe(-1);
    expect(compareVersions("1.3.0", "1.2.9")).toBe(1);
    expect(compareVersions("0.9.9", "1.0.0")).toBe(-1);
  });

  test("strips leading v and pre-release suffix", () => {
    expect(compareVersions("v1.2.3-beta", "1.2.3")).toBe(0);
    expect(compareVersions("1.2.3", "1.2.4-rc1")).toBe(-1);
  });

  test("treats missing components as zero", () => {
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
    expect(compareVersions("1", "1.0.1")).toBe(-1);
  });
});

describe("startUpdateCheck", () => {
  let workDir: string;
  let stateFile: string;
  let originalNoCheck: string | undefined;
  let originalCI: string | undefined;
  let originalTTY: boolean | undefined;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "pluggy-update-check-"));
    stateFile = join(workDir, "update-check.json");
    originalNoCheck = process.env.PLUGGY_NO_UPDATE_CHECK;
    originalCI = process.env.CI;
    originalTTY = process.stderr.isTTY;
    delete process.env.PLUGGY_NO_UPDATE_CHECK;
    delete process.env.CI;
    Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });
  });

  afterEach(async () => {
    if (originalNoCheck === undefined) delete process.env.PLUGGY_NO_UPDATE_CHECK;
    else process.env.PLUGGY_NO_UPDATE_CHECK = originalNoCheck;
    if (originalCI === undefined) delete process.env.CI;
    else process.env.CI = originalCI;
    Object.defineProperty(process.stderr, "isTTY", {
      value: originalTTY,
      configurable: true,
    });
    vi.restoreAllMocks();
    await rm(workDir, { recursive: true, force: true });
  });

  test("prints banner to stderr when cached version is newer", async () => {
    await writeFile(
      stateFile,
      JSON.stringify({ latestVersion: "0.5.0", lastCheckedAt: new Date().toISOString() }),
    );
    const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const handle = await startUpdateCheck({
      repository: "pluggy-sh/pluggy",
      currentVersion: "0.1.0",
      stateFile,
    });
    handle.printBannerIfOutdated();
    handle.dispose();
    expect(writeSpy).toHaveBeenCalled();
    const arg = writeSpy.mock.calls[0]?.[0] as string;
    expect(arg).toContain("0.5.0");
    expect(arg).toContain("pluggy upgrade");
  });

  test("does not print when cached version equals current", async () => {
    await writeFile(
      stateFile,
      JSON.stringify({ latestVersion: "0.1.0", lastCheckedAt: new Date().toISOString() }),
    );
    const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const handle = await startUpdateCheck({
      repository: "pluggy-sh/pluggy",
      currentVersion: "0.1.0",
      stateFile,
    });
    handle.printBannerIfOutdated();
    handle.dispose();
    expect(writeSpy).not.toHaveBeenCalled();
  });

  test("suppressed when --json", async () => {
    await writeFile(
      stateFile,
      JSON.stringify({ latestVersion: "9.9.9", lastCheckedAt: new Date().toISOString() }),
    );
    const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const handle = await startUpdateCheck({
      repository: "pluggy-sh/pluggy",
      currentVersion: "0.1.0",
      json: true,
      stateFile,
    });
    handle.printBannerIfOutdated();
    handle.dispose();
    expect(writeSpy).not.toHaveBeenCalled();
  });

  test("suppressed when CI=true", async () => {
    process.env.CI = "true";
    await writeFile(
      stateFile,
      JSON.stringify({ latestVersion: "9.9.9", lastCheckedAt: new Date().toISOString() }),
    );
    const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const handle = await startUpdateCheck({
      repository: "pluggy-sh/pluggy",
      currentVersion: "0.1.0",
      stateFile,
    });
    handle.printBannerIfOutdated();
    handle.dispose();
    expect(writeSpy).not.toHaveBeenCalled();
  });

  test("suppressed when PLUGGY_NO_UPDATE_CHECK=1", async () => {
    process.env.PLUGGY_NO_UPDATE_CHECK = "1";
    await writeFile(
      stateFile,
      JSON.stringify({ latestVersion: "9.9.9", lastCheckedAt: new Date().toISOString() }),
    );
    const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const handle = await startUpdateCheck({
      repository: "pluggy-sh/pluggy",
      currentVersion: "0.1.0",
      stateFile,
    });
    handle.printBannerIfOutdated();
    handle.dispose();
    expect(writeSpy).not.toHaveBeenCalled();
  });

  test("suppressed for dev build version 0.0.0", async () => {
    await writeFile(
      stateFile,
      JSON.stringify({ latestVersion: "9.9.9", lastCheckedAt: new Date().toISOString() }),
    );
    const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const handle = await startUpdateCheck({
      repository: "pluggy-sh/pluggy",
      currentVersion: "0.0.0",
      stateFile,
    });
    handle.printBannerIfOutdated();
    handle.dispose();
    expect(writeSpy).not.toHaveBeenCalled();
  });

  test("missing state file is handled silently", async () => {
    const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ tag_name: "v0.2.0" }), { status: 200 }));
    const handle = await startUpdateCheck({
      repository: "pluggy-sh/pluggy",
      currentVersion: "0.1.0",
      stateFile,
    });
    handle.printBannerIfOutdated();
    handle.dispose();
    expect(writeSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  test("fresh cache (within interval) does not refetch", async () => {
    await writeFile(
      stateFile,
      JSON.stringify({ latestVersion: "0.1.0", lastCheckedAt: new Date().toISOString() }),
    );
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    const handle = await startUpdateCheck({
      repository: "pluggy-sh/pluggy",
      currentVersion: "0.1.0",
      stateFile,
    });
    handle.dispose();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  test("getCachedLatestVersion reads from disk", async () => {
    await writeFile(
      stateFile,
      JSON.stringify({ latestVersion: "0.7.0", lastCheckedAt: new Date().toISOString() }),
    );
    expect(await getCachedLatestVersion(stateFile)).toBe("0.7.0");
  });

  test("getCachedLatestVersion returns undefined when no state", async () => {
    expect(await getCachedLatestVersion(stateFile)).toBeUndefined();
  });
});
