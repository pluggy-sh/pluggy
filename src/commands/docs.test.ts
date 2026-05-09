/**
 * Tests for src/commands/docs.ts. Real workspace resolver + on-disk
 * `project.json`; `generateDocs` is mocked so no Java tooling runs.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

vi.mock("../docs/index.ts", () => ({
  generateDocs: vi.fn(),
}));

import { generateDocs } from "../docs/index.ts";

import { initLogging } from "../logging.ts";
import { runDocsCommand, selectDocsTargets } from "./docs.ts";
import { resolveWorkspaceContext } from "../workspace.ts";

describe("runDocsCommand", () => {
  let rootDir: string;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "pluggy-docs-cmd-"));
    stdoutSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(generateDocs).mockReset();
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
      JSON.stringify({ name: "suite_api", version: "0.1.0", main: "com.example.api.Plugin" }),
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

  test("single workspace: calls generateDocs once and reports success", async () => {
    await writeStandalone();
    vi.mocked(generateDocs).mockResolvedValueOnce({
      outputPath: "/tmp/docs/standalone-1.0.0",
      fileCount: 12,
      sizeBytes: 4096,
      warnings: 0,
      durationMs: 42,
    });

    const res = await runDocsCommand({ cwd: rootDir });

    expect(res.exitCode).toBe(0);
    expect(res.status).toBe("success");
    expect(res.results).toHaveLength(1);
    expect(res.results[0].ok).toBe(true);
    expect(res.results[0].outputPath).toBe("/tmp/docs/standalone-1.0.0");
    expect(res.results[0].fileCount).toBe(12);
    expect(generateDocs).toHaveBeenCalledTimes(1);
  });

  test("multi-workspace: documents in topological order (api before impl)", async () => {
    await writeMultiWorkspace();
    vi.mocked(generateDocs).mockResolvedValue({
      outputPath: "/tmp/docs/x",
      fileCount: 1,
      sizeBytes: 1,
      warnings: 0,
      durationMs: 1,
    });

    const res = await runDocsCommand({ cwd: rootDir });

    expect(res.exitCode).toBe(0);
    expect(res.results).toHaveLength(2);
    const calls = vi.mocked(generateDocs).mock.calls;
    expect(calls[0][0].name).toBe("suite_api");
    expect(calls[1][0].name).toBe("suite_impl");
  });

  test("forwards --private as access: 'private'", async () => {
    await writeStandalone();
    vi.mocked(generateDocs).mockResolvedValueOnce({
      outputPath: "/tmp/docs/x",
      fileCount: 1,
      sizeBytes: 1,
      warnings: 0,
      durationMs: 1,
    });

    await runDocsCommand({ cwd: rootDir, private: true });

    expect(vi.mocked(generateDocs).mock.calls[0][1]).toMatchObject({ access: "private" });
  });

  test("forwards --link entries as the links option", async () => {
    await writeStandalone();
    vi.mocked(generateDocs).mockResolvedValueOnce({
      outputPath: "/tmp/docs/x",
      fileCount: 1,
      sizeBytes: 1,
      warnings: 0,
      durationMs: 1,
    });

    await runDocsCommand({
      cwd: rootDir,
      links: ["https://docs.oracle.com/en/java/javase/21/docs/api/"],
    });

    expect(vi.mocked(generateDocs).mock.calls[0][1]).toMatchObject({
      links: ["https://docs.oracle.com/en/java/javase/21/docs/api/"],
    });
  });

  test("one workspace fails: continues through the rest but exits 1", async () => {
    await writeMultiWorkspace();
    vi.mocked(generateDocs)
      .mockRejectedValueOnce(new Error("javadoc exited"))
      .mockResolvedValueOnce({
        outputPath: "/tmp/docs/impl",
        fileCount: 5,
        sizeBytes: 100,
        warnings: 0,
        durationMs: 9,
      });

    const res = await runDocsCommand({ cwd: rootDir });

    expect(res.exitCode).toBe(1);
    expect(res.status).toBe("partial");
    expect(res.results).toHaveLength(2);
    expect(res.results[0].ok).toBe(false);
    expect(res.results[0].error).toContain("javadoc exited");
    expect(res.results[1].ok).toBe(true);
  });

  test("--json success → single JSON object on stdout", async () => {
    await writeStandalone();
    vi.mocked(generateDocs).mockResolvedValueOnce({
      outputPath: "/tmp/docs/standalone-1.0.0",
      fileCount: 7,
      sizeBytes: 2048,
      warnings: 1,
      durationMs: 3,
    });

    initLogging({ json: true });
    await runDocsCommand({ cwd: rootDir });

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(stdoutSpy.mock.calls[0][0] as string);
    expect(parsed.status).toBe("success");
    expect(parsed.results[0].ok).toBe(true);
    expect(parsed.results[0].fileCount).toBe(7);
    expect(parsed.results[0].warnings).toBe(1);
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  test("--json with partial failure → JSON on stderr, exit 1", async () => {
    await writeMultiWorkspace();
    vi.mocked(generateDocs).mockRejectedValueOnce(new Error("nope")).mockResolvedValueOnce({
      outputPath: "/tmp/docs/impl",
      fileCount: 1,
      sizeBytes: 1,
      warnings: 0,
      durationMs: 1,
    });

    initLogging({ json: true });
    const res = await runDocsCommand({ cwd: rootDir });

    expect(res.exitCode).toBe(1);
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(stderrSpy.mock.calls[0][0] as string);
    expect(parsed.status).toBe("error");
    expect(parsed.results[0].ok).toBe(false);
    expect(parsed.results[1].ok).toBe(true);
  });
});

describe("selectDocsTargets", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "pluggy-docs-sel-"));
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
    const targets = selectDocsTargets(ctx!, {});
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
    const targets = selectDocsTargets(ctx, {});
    expect(targets.map((t) => t.name)).toEqual(["a", "b"]);
  });
});
