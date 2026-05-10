/**
 * Tests for src/commands/test.ts. Real workspace resolver + on-disk
 * `project.json`; `runTests` is mocked so no JVM is spawned.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

vi.mock("../test/index.ts", () => ({
  runTests: vi.fn(),
}));

import { runTests } from "../test/index.ts";

import { initLogging } from "../logging.ts";
import { runTestCommand, selectTestTargets } from "./test.ts";
import { resolveWorkspaceContext } from "../workspace.ts";

describe("runTestCommand", () => {
  let rootDir: string;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "pluggy-test-cmd-"));
    stdoutSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(runTests).mockReset();
    initLogging({ json: false, verbose: false, noColor: true });
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    vi.restoreAllMocks();
    initLogging({ json: false, verbose: false, noColor: true });
  });

  async function writeStandalone(): Promise<void> {
    await writeFile(
      join(rootDir, "project.json"),
      JSON.stringify({
        name: "standalone",
        version: "1.0.0",
        main: "com.example.Main",
        compatibility: { versions: ["1.21.8"], platforms: ["paper"] },
      }),
    );
  }

  async function writeMultiWorkspace(): Promise<void> {
    await mkdir(join(rootDir, "modules", "api"), { recursive: true });
    await mkdir(join(rootDir, "modules", "impl"), { recursive: true });
    await writeFile(
      join(rootDir, "project.json"),
      JSON.stringify({
        name: "suite",
        version: "1.0.0",
        compatibility: { versions: ["1.21.8"], platforms: ["paper"] },
        workspaces: ["./modules/api", "./modules/impl"],
      }),
    );
    await writeFile(
      join(rootDir, "modules", "api", "project.json"),
      JSON.stringify({
        name: "suite_api",
        version: "0.1.0",
        main: "com.example.api.Plugin",
      }),
    );
    await writeFile(
      join(rootDir, "modules", "impl", "project.json"),
      JSON.stringify({
        name: "suite_impl",
        version: "0.1.0",
        main: "com.example.impl.Plugin",
        dependencies: {
          suite_api: { source: "workspace:suite_api", version: "*" },
        },
      }),
    );
  }

  test("all tests pass → exitCode 0, status success", async () => {
    await writeStandalone();
    vi.mocked(runTests).mockResolvedValueOnce({
      status: "ok",
      durationMs: 100,
      result: {
        total: 3,
        passed: 3,
        failed: 0,
        skipped: 0,
        cases: [
          { suite: "com.example.FooTest", name: "a", durationMs: 1, status: "passed" },
          { suite: "com.example.FooTest", name: "b", durationMs: 2, status: "passed" },
          { suite: "com.example.FooTest", name: "c", durationMs: 3, status: "passed" },
        ],
      },
    });

    const res = await runTestCommand({ cwd: rootDir });

    expect(res.exitCode).toBe(0);
    expect(res.status).toBe("success");
    expect(res.results[0]).toMatchObject({
      ok: true,
      tests: { total: 3, passed: 3, failed: 0, skipped: 0 },
    });
    expect(res.results[0].cells).toHaveLength(1);
    expect(res.results[0].cells[0]).toMatchObject({
      mcVersion: "1.21.8",
      platformId: "paper",
      ok: true,
    });
  });

  test("test failure → exitCode 1, failures array populated", async () => {
    await writeStandalone();
    vi.mocked(runTests).mockResolvedValueOnce({
      status: "ok",
      durationMs: 50,
      result: {
        total: 2,
        passed: 1,
        failed: 1,
        skipped: 0,
        cases: [
          { suite: "A", name: "p", durationMs: 1, status: "passed" },
          {
            suite: "A",
            name: "f",
            durationMs: 2,
            status: "failed",
            message: "expected true",
            stackTrace: "at A.f(A.java:1)",
          },
        ],
      },
    });

    const res = await runTestCommand({ cwd: rootDir });

    expect(res.exitCode).toBe(1);
    expect(res.status).toBe("partial");
    expect(res.results[0].failures).toEqual([
      {
        class: "A",
        test: "f",
        durationMs: 2,
        message: "expected true",
        stackTrace: "at A.f(A.java:1)",
        mcVersion: "1.21.8",
        platformId: "paper",
      },
    ]);
  });

  test("no-test-dir → ok=true, skipped field set, exitCode 0", async () => {
    await writeStandalone();
    vi.mocked(runTests).mockResolvedValueOnce({
      status: "no-tests",
      durationMs: 5,
      reason: "no-test-dir",
    });

    const res = await runTestCommand({ cwd: rootDir });

    expect(res.exitCode).toBe(0);
    expect(res.results[0].ok).toBe(true);
    expect(res.results[0].skipped).toBe("no-test-dir");
    expect(res.results[0].tests).toBeUndefined();
  });

  test("multi-workspace: runs in topo order, continues on failure", async () => {
    await writeMultiWorkspace();
    vi.mocked(runTests)
      .mockResolvedValueOnce({
        status: "ok",
        durationMs: 10,
        result: { total: 1, passed: 1, failed: 0, skipped: 0, cases: [] },
      })
      .mockRejectedValueOnce(new Error("compile boom"));

    const res = await runTestCommand({ cwd: rootDir });

    expect(res.exitCode).toBe(1);
    expect(res.status).toBe("partial");
    expect(res.results).toHaveLength(2);
    expect(res.results[0]).toMatchObject({ workspace: "suite_api", ok: true });
    expect(res.results[1]).toMatchObject({ workspace: "suite_impl", ok: false });
    expect(res.results[1].error).toContain("compile boom");
    expect(runTests).toHaveBeenCalledTimes(2);
  });

  test("single-target compile failure rethrows (no second target to continue with)", async () => {
    await writeStandalone();
    vi.mocked(runTests).mockRejectedValueOnce(new Error("javac exited with code 1"));

    await expect(runTestCommand({ cwd: rootDir })).rejects.toThrow(/javac exited/);
  });

  test("--json success → single JSON object on stdout", async () => {
    await writeStandalone();
    vi.mocked(runTests).mockResolvedValueOnce({
      status: "ok",
      durationMs: 100,
      result: {
        total: 1,
        passed: 1,
        failed: 0,
        skipped: 0,
        cases: [{ suite: "A", name: "x", durationMs: 1, status: "passed" }],
      },
    });

    initLogging({ json: true });
    await runTestCommand({ cwd: rootDir });

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(stdoutSpy.mock.calls[0][0] as string);
    expect(parsed.status).toBe("success");
    expect(parsed.results[0].tests).toEqual({ total: 1, passed: 1, failed: 0, skipped: 0 });
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  test("--json with failures → JSON on stderr, exit 1", async () => {
    await writeStandalone();
    vi.mocked(runTests).mockResolvedValueOnce({
      status: "ok",
      durationMs: 1,
      result: {
        total: 1,
        passed: 0,
        failed: 1,
        skipped: 0,
        cases: [{ suite: "A", name: "f", durationMs: 1, status: "failed", message: "nope" }],
      },
    });

    initLogging({ json: true });
    const res = await runTestCommand({ cwd: rootDir });

    expect(res.exitCode).toBe(1);
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(stderrSpy.mock.calls[0][0] as string);
    expect(parsed.status).toBe("error");
    expect(parsed.results[0].failures[0].message).toBe("nope");
  });

  test("--workspace narrows at root", async () => {
    await writeMultiWorkspace();
    vi.mocked(runTests).mockResolvedValue({
      status: "ok",
      durationMs: 1,
      result: { total: 0, passed: 0, failed: 0, skipped: 0, cases: [] },
    });

    const res = await runTestCommand({ cwd: rootDir, workspace: "suite_impl" });

    expect(res.results).toHaveLength(1);
    expect(res.results[0].workspace).toBe("suite_impl");
    expect(runTests).toHaveBeenCalledTimes(1);
  });

  test("passes filter and failFast through to runTests", async () => {
    await writeStandalone();
    vi.mocked(runTests).mockResolvedValueOnce({
      status: "ok",
      durationMs: 1,
      result: { total: 0, passed: 0, failed: 0, skipped: 0, cases: [] },
    });

    await runTestCommand({ cwd: rootDir, filter: "@tag:slow", failFast: true });

    const call = vi.mocked(runTests).mock.calls[0];
    expect(call[1]).toMatchObject({ filter: "@tag:slow", failFast: true });
  });

  async function writeMatrixProject(): Promise<void> {
    await writeFile(
      join(rootDir, "project.json"),
      JSON.stringify({
        name: "matrix",
        version: "1.0.0",
        main: "com.example.Main",
        compatibility: {
          versions: ["1.21.4", "1.20.4"],
          platforms: ["paper", "spigot"],
        },
      }),
    );
  }

  function okOutcome(
    mcVersion?: string,
    platformId?: string,
  ): {
    status: "ok";
    durationMs: number;
    result: { total: number; passed: number; failed: number; skipped: number; cases: [] };
    mcVersion?: string;
    platformId?: string;
    jdkMajor?: number;
  } {
    return {
      status: "ok",
      durationMs: 1,
      result: { total: 1, passed: 1, failed: 0, skipped: 0, cases: [] },
      mcVersion,
      platformId,
      jdkMajor: 21,
    };
  }

  test("expands a 2x2 matrix into four runTests calls", async () => {
    await writeMatrixProject();
    vi.mocked(runTests).mockImplementation(async (_p, opts) =>
      okOutcome(opts?.mcVersion, opts?.platformId),
    );

    const res = await runTestCommand({ cwd: rootDir });

    expect(res.exitCode).toBe(0);
    expect(runTests).toHaveBeenCalledTimes(4);
    const cellCoords = res.results[0].cells.map((c) => `${c.mcVersion}:${c.platformId}`);
    expect(cellCoords).toEqual(["1.21.4:paper", "1.21.4:spigot", "1.20.4:paper", "1.20.4:spigot"]);
    expect(res.results[0].tests).toEqual({ total: 4, passed: 4, failed: 0, skipped: 0 });
  });

  test("--mc-version and --platform narrow the matrix", async () => {
    await writeMatrixProject();
    vi.mocked(runTests).mockImplementation(async (_p, opts) =>
      okOutcome(opts?.mcVersion, opts?.platformId),
    );

    const res = await runTestCommand({
      cwd: rootDir,
      mcVersions: ["1.21.4"],
      platforms: ["paper"],
    });

    expect(runTests).toHaveBeenCalledTimes(1);
    expect(res.results[0].cells).toHaveLength(1);
    expect(res.results[0].cells[0]).toMatchObject({ mcVersion: "1.21.4", platformId: "paper" });
  });

  test("--mc-version with an undeclared value rejects with a clear error", async () => {
    await writeMatrixProject();

    await expect(runTestCommand({ cwd: rootDir, mcVersions: ["1.99.0"] })).rejects.toThrow(
      /--mc-version "1.99.0"/,
    );
    expect(runTests).not.toHaveBeenCalled();
  });

  test("mixed-family platforms fail matrix expansion before running cells", async () => {
    await writeFile(
      join(rootDir, "project.json"),
      JSON.stringify({
        name: "mixed",
        version: "1.0.0",
        main: "com.example.Main",
        compatibility: { versions: ["1.21.4"], platforms: ["paper", "velocity"] },
      }),
    );

    await expect(runTestCommand({ cwd: rootDir })).rejects.toThrow(/must share one family/);
    expect(runTests).not.toHaveBeenCalled();
  });

  test("--fail-fast stops the matrix at the first failed cell", async () => {
    await writeMatrixProject();
    vi.mocked(runTests).mockResolvedValueOnce({
      status: "ok",
      durationMs: 1,
      result: {
        total: 1,
        passed: 0,
        failed: 1,
        skipped: 0,
        cases: [{ suite: "A", name: "f", durationMs: 1, status: "failed", message: "x" }],
      },
      mcVersion: "1.21.4",
      platformId: "paper",
      jdkMajor: 21,
    });

    const res = await runTestCommand({ cwd: rootDir, failFast: true });

    expect(res.exitCode).toBe(1);
    expect(runTests).toHaveBeenCalledTimes(1);
    expect(res.results[0].cells).toHaveLength(1);
  });
});

describe("selectTestTargets", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "pluggy-test-sel-"));
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  test("standalone: one target, the root project", async () => {
    await writeFile(
      join(rootDir, "project.json"),
      JSON.stringify({
        name: "solo",
        version: "1.0.0",
        main: "com.example.Main",
        compatibility: { versions: ["1.21.8"], platforms: ["paper"] },
      }),
    );
    const ctx = resolveWorkspaceContext(rootDir);
    const targets = selectTestTargets(ctx!, {});
    expect(targets).toHaveLength(1);
    expect(targets[0].name).toBe("solo");
  });

  test("unknown --workspace throws", async () => {
    await mkdir(join(rootDir, "modules", "a"), { recursive: true });
    await writeFile(
      join(rootDir, "project.json"),
      JSON.stringify({
        name: "r",
        version: "1.0.0",
        compatibility: { versions: ["1.21.8"], platforms: ["paper"] },
        workspaces: ["./modules/a"],
      }),
    );
    await writeFile(
      join(rootDir, "modules", "a", "project.json"),
      JSON.stringify({ name: "a", version: "0.1.0", main: "a.M" }),
    );
    const ctx = resolveWorkspaceContext(rootDir)!;
    expect(() => selectTestTargets(ctx, { workspace: "does-not-exist" })).toThrow(
      /workspace not found/,
    );
  });
});
