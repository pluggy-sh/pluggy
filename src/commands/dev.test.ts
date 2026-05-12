/** Tests for src/commands/dev.ts. `runDev` is mocked: no real server spawned. */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

vi.mock("../dev/index.ts", () => ({
  runDev: vi.fn(async () => {}),
}));

import { runDev } from "../dev/index.ts";

import { initLogging } from "../logging.ts";
import { runDevCommand, selectDevTarget } from "./dev.ts";
import { resolveWorkspaceContext } from "../workspace.ts";

describe("runDevCommand", () => {
  let rootDir: string;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "pluggy-dev-cmd-"));
    stdoutSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.mocked(runDev).mockReset();
    vi.mocked(runDev).mockResolvedValue();
    initLogging({ json: false, verbose: false, noColor: true });
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
    stdoutSpy.mockRestore();
    vi.restoreAllMocks();
    initLogging({ json: false, verbose: false, noColor: true });
  });

  async function writeStandalone(): Promise<void> {
    await writeFile(
      join(rootDir, "project.json"),
      JSON.stringify({
        name: "solo",
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
      }),
    );
  }

  test("standalone: invokes runDev with the standalone project", async () => {
    await writeStandalone();
    await runDevCommand({ cwd: rootDir });
    expect(runDev).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runDev).mock.calls[0][0].name).toBe("solo");
  });

  test("at root with workspaces: requires --workspace", async () => {
    await writeMultiWorkspace();
    await expect(runDevCommand({ cwd: rootDir })).rejects.toThrow(/--workspace/);
    expect(runDev).not.toHaveBeenCalled();
  });

  test("at root with workspaces: --workspace selects the target", async () => {
    await writeMultiWorkspace();
    await runDevCommand({ cwd: rootDir, workspace: "suite_impl" });
    expect(runDev).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runDev).mock.calls[0][0].name).toBe("suite_impl");
  });

  test("inside a workspace: uses the current workspace automatically", async () => {
    await writeMultiWorkspace();
    await runDevCommand({ cwd: join(rootDir, "modules", "api") });
    expect(runDev).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runDev).mock.calls[0][0].name).toBe("suite_api");
  });

  test("--no-watch (watch=false) is passed through to runDev verbatim", async () => {
    await writeStandalone();
    await runDevCommand({ cwd: rootDir, watch: false });
    expect(vi.mocked(runDev).mock.calls[0][1].watch).toBe(false);
  });

  test("default watch (undefined) is also passed through: runDev treats !== false as watch-on", async () => {
    await writeStandalone();
    await runDevCommand({ cwd: rootDir });
    expect(vi.mocked(runDev).mock.calls[0][1].watch).toBeUndefined();
  });

  test("--json emits a single startup line on stdout", async () => {
    await writeStandalone();
    initLogging({ json: true });
    await runDevCommand({ cwd: rootDir });

    const jsonCalls = stdoutSpy.mock.calls.filter((c: unknown[]) => {
      try {
        return typeof c[0] === "string" && JSON.parse(c[0] as string).status === "starting";
      } catch {
        return false;
      }
    });
    expect(jsonCalls).toHaveLength(1);
    const parsed = JSON.parse(jsonCalls[0][0] as string);
    expect(parsed.status).toBe("starting");
    expect(parsed.platform).toBe("paper");
    expect(parsed.version).toBe("1.21.8");
    expect(parsed.port).toBe(25565);
    expect(parsed.devDir).toBe(join(rootDir, "dev"));
  });

  test("errors from runDev are not swallowed", async () => {
    await writeStandalone();
    vi.mocked(runDev).mockRejectedValueOnce(new Error("server crashed"));
    await expect(runDevCommand({ cwd: rootDir })).rejects.toThrow(/server crashed/);
  });
});

describe("selectDevTarget", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "pluggy-dev-sel-"));
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  test("standalone: returns the root project", async () => {
    await writeFile(
      join(rootDir, "project.json"),
      JSON.stringify({
        name: "solo",
        version: "1.0.0",
        main: "com.example.Main",
        compatibility: { versions: ["1.21.8"], platforms: ["paper"] },
      }),
    );
    const ctx = resolveWorkspaceContext(rootDir)!;
    const target = selectDevTarget(ctx, {});
    expect(target.name).toBe("solo");
  });

  test("root + workspaces: one shipping workspace → auto-picks it", async () => {
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
    const target = selectDevTarget(ctx, {});
    expect(target.name).toBe("a");
  });

  test("root + workspaces: zero shipping → enriched error", async () => {
    await mkdir(join(rootDir, "modules", "api"), { recursive: true });
    await mkdir(join(rootDir, "modules", "core"), { recursive: true });
    await writeFile(
      join(rootDir, "project.json"),
      JSON.stringify({
        name: "r",
        version: "1.0.0",
        compatibility: { versions: ["1.21.8"], platforms: ["paper"] },
        workspaces: ["./modules/api", "./modules/core"],
      }),
    );
    // Both internal: no `main` declared.
    await writeFile(
      join(rootDir, "modules", "api", "project.json"),
      JSON.stringify({ name: "api", version: "0.1.0" }),
    );
    await writeFile(
      join(rootDir, "modules", "core", "project.json"),
      JSON.stringify({ name: "core", version: "0.1.0" }),
    );
    const ctx = resolveWorkspaceContext(rootDir)!;
    expect(() => selectDevTarget(ctx, {})).toThrow(/no workspace declares.*main/);
  });

  test("root + workspaces: multiple shipping → enriched error lists each", async () => {
    await mkdir(join(rootDir, "modules", "paper"), { recursive: true });
    await mkdir(join(rootDir, "modules", "sponge"), { recursive: true });
    await writeFile(
      join(rootDir, "project.json"),
      JSON.stringify({
        name: "r",
        version: "1.0.0",
        compatibility: { versions: ["1.21.8"], platforms: ["paper"] },
        workspaces: ["./modules/paper", "./modules/sponge"],
      }),
    );
    await writeFile(
      join(rootDir, "modules", "paper", "project.json"),
      JSON.stringify({
        name: "ws_paper",
        version: "0.1.0",
        main: "p.M",
        compatibility: { versions: ["1.21.8"], platforms: ["paper"] },
      }),
    );
    await writeFile(
      join(rootDir, "modules", "sponge", "project.json"),
      JSON.stringify({
        name: "ws_sponge",
        version: "0.1.0",
        main: "s.M",
        compatibility: { versions: ["1.21.8"], platforms: ["sponge"] },
      }),
    );
    const ctx = resolveWorkspaceContext(rootDir)!;
    let caught: Error | undefined;
    try {
      selectDevTarget(ctx, {});
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeDefined();
    expect(caught?.message).toMatch(/2 workspaces declare/);
    expect(caught?.message).toContain("ws_paper");
    expect(caught?.message).toContain("ws_sponge");
  });

  test("root + workspaces: unknown --workspace name throws", async () => {
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
    expect(() => selectDevTarget(ctx, { workspace: "nope" })).toThrow(/workspace not found/);
  });
});
