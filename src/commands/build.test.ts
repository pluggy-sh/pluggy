/**
 * Tests for src/commands/build.ts. Real workspace resolver + on-disk
 * `project.json`; `buildProject` is mocked so no Java compiles.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

vi.mock("../build/index.ts", () => ({
  buildProject: vi.fn(),
}));

import { buildProject } from "../build/index.ts";

import { initLogging } from "../logging.ts";
import { runBuildCommand, selectBuildTargets } from "./build.ts";
import { resolveWorkspaceContext } from "../workspace.ts";

describe("runBuildCommand", () => {
  let rootDir: string;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "pluggy-build-cmd-"));
    stdoutSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(buildProject).mockReset();
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

  test("single workspace: calls buildProject once and reports success", async () => {
    await writeStandalone();
    vi.mocked(buildProject).mockResolvedValueOnce({
      outputPath: "/tmp/out.jar",
      sizeBytes: 1024,
      durationMs: 42,
      stagingDir: "/tmp/staging",
    });

    const res = await runBuildCommand({ cwd: rootDir });

    expect(res.exitCode).toBe(0);
    expect(res.status).toBe("success");
    expect(res.results).toHaveLength(1);
    expect(res.results[0].ok).toBe(true);
    expect(res.results[0].outputPath).toBe("/tmp/out.jar");
    expect(buildProject).toHaveBeenCalledTimes(1);
  });

  test("multi-workspace: builds in topological order (api before impl)", async () => {
    await writeMultiWorkspace();
    vi.mocked(buildProject).mockResolvedValue({
      outputPath: "/tmp/out.jar",
      sizeBytes: 100,
      durationMs: 1,
      stagingDir: "/tmp/staging",
    });

    const res = await runBuildCommand({ cwd: rootDir });

    expect(res.exitCode).toBe(0);
    expect(res.results).toHaveLength(2);

    const calls = vi.mocked(buildProject).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0][0].name).toBe("suite_api");
    expect(calls[1][0].name).toBe("suite_impl");
  });

  test("one workspace fails: continues through the rest but exits 1", async () => {
    await writeMultiWorkspace();
    vi.mocked(buildProject).mockRejectedValueOnce(new Error("boom on api")).mockResolvedValueOnce({
      outputPath: "/tmp/impl.jar",
      sizeBytes: 10,
      durationMs: 5,
      stagingDir: "/tmp/staging",
    });

    const res = await runBuildCommand({ cwd: rootDir });

    expect(res.exitCode).toBe(1);
    expect(res.status).toBe("partial");
    expect(res.results).toHaveLength(2);
    expect(res.results[0].ok).toBe(false);
    expect(res.results[0].error).toContain("boom on api");
    expect(res.results[1].ok).toBe(true);
    expect(buildProject).toHaveBeenCalledTimes(2);
  });

  test("--workspace narrows to one even at root", async () => {
    await writeMultiWorkspace();
    vi.mocked(buildProject).mockResolvedValue({
      outputPath: "/tmp/out.jar",
      sizeBytes: 10,
      durationMs: 1,
      stagingDir: "/tmp/staging",
    });

    const res = await runBuildCommand({ cwd: rootDir, workspace: "suite_impl" });

    expect(res.results).toHaveLength(1);
    expect(res.results[0].workspace).toBe("suite_impl");
    expect(buildProject).toHaveBeenCalledTimes(1);
    expect(vi.mocked(buildProject).mock.calls[0][0].name).toBe("suite_impl");
  });

  test("--json success → single JSON object on stdout", async () => {
    await writeStandalone();
    initLogging({ json: true });
    vi.mocked(buildProject).mockResolvedValueOnce({
      outputPath: "/tmp/out.jar",
      sizeBytes: 512,
      durationMs: 3,
      stagingDir: "/tmp/staging",
    });

    await runBuildCommand({ cwd: rootDir });

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    const printed = stdoutSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(printed);
    expect(parsed.status).toBe("success");
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0].ok).toBe(true);
    expect(parsed.results[0].outputPath).toBe("/tmp/out.jar");
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  test("--json with partial failure → JSON on stderr, exit 1", async () => {
    await writeMultiWorkspace();
    initLogging({ json: true });
    vi.mocked(buildProject).mockRejectedValueOnce(new Error("nope")).mockResolvedValueOnce({
      outputPath: "/tmp/impl.jar",
      sizeBytes: 1,
      durationMs: 1,
      stagingDir: "/tmp/staging",
    });

    const res = await runBuildCommand({ cwd: rootDir });

    expect(res.exitCode).toBe(1);
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(stderrSpy.mock.calls[0][0] as string);
    expect(parsed.status).toBe("error");
    expect(parsed.results[0].ok).toBe(false);
    expect(parsed.results[1].ok).toBe(true);
  });
});

describe("selectBuildTargets", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "pluggy-build-sel-"));
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
    const targets = selectBuildTargets(ctx!, {});
    expect(targets).toHaveLength(1);
    expect(targets[0].name).toBe("solo");
  });

  test("root with workspaces → all workspaces in topo order", async () => {
    await mkdir(join(rootDir, "modules", "a"), { recursive: true });
    await mkdir(join(rootDir, "modules", "b"), { recursive: true });
    await writeFile(
      join(rootDir, "project.json"),
      JSON.stringify({
        name: "r",
        version: "1.0.0",
        compatibility: { versions: ["1.21.8"], platforms: ["paper"] },
        workspaces: ["./modules/a", "./modules/b"],
      }),
    );
    await writeFile(
      join(rootDir, "modules", "a", "project.json"),
      JSON.stringify({ name: "a", version: "0.1.0", main: "a.M" }),
    );
    await writeFile(
      join(rootDir, "modules", "b", "project.json"),
      JSON.stringify({
        name: "b",
        version: "0.1.0",
        main: "b.M",
        dependencies: { a: { source: "workspace:a", version: "*" } },
      }),
    );

    const ctx = resolveWorkspaceContext(rootDir)!;
    const targets = selectBuildTargets(ctx, {});
    expect(targets.map((t) => t.name)).toEqual(["a", "b"]);
  });

  test("unknown --workspace name throws", async () => {
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
    expect(() => selectBuildTargets(ctx, { workspace: "does-not-exist" })).toThrow(
      /workspace not found/,
    );
  });
});
