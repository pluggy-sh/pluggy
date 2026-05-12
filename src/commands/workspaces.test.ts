/** Contract tests for `pluggy workspaces`. */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import { initLogging } from "../logging.ts";
import { runWorkspacesCommand } from "./workspaces.ts";

describe("runWorkspacesCommand", () => {
  let rootDir: string;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "pluggy-workspaces-"));
    stdoutSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    initLogging({ json: false, verbose: false, noColor: true });
  });

  afterEach(async () => {
    stdoutSpy.mockRestore();
    await rm(rootDir, { recursive: true, force: true });
  });

  test("standalone project: empty workspaces array, schemaVersion 1", async () => {
    await writeFile(
      join(rootDir, "project.json"),
      JSON.stringify({
        name: "solo",
        version: "1.0.0",
        main: "com.example.Plugin",
        compatibility: { versions: ["1.21"], platforms: ["paper"] },
      }),
    );

    const res = await runWorkspacesCommand({ cwd: rootDir });
    expect(res.schemaVersion).toBe(1);
    expect(res.workspaces).toEqual([]);
  });

  test("multi-workspace: lists in topological order with derived roles", async () => {
    await mkdir(join(rootDir, "api"), { recursive: true });
    await mkdir(join(rootDir, "core"), { recursive: true });
    await mkdir(join(rootDir, "plugin"), { recursive: true });
    await writeFile(
      join(rootDir, "project.json"),
      JSON.stringify({
        name: "suite",
        version: "1.0.0",
        compatibility: { versions: ["1.21"], platforms: ["paper"] },
        workspaces: ["./api", "./core", "./plugin"],
      }),
    );
    await writeFile(
      join(rootDir, "api", "project.json"),
      JSON.stringify({ name: "api", version: "0.1.0" }),
    );
    await writeFile(
      join(rootDir, "core", "project.json"),
      JSON.stringify({
        name: "core",
        version: "0.1.0",
        dependencies: { api: { source: "workspace:api", version: "*" } },
      }),
    );
    await writeFile(
      join(rootDir, "plugin", "project.json"),
      JSON.stringify({
        name: "plugin",
        version: "0.1.0",
        main: "com.example.Plugin",
        dependencies: {
          api: { source: "workspace:api", version: "*" },
          core: { source: "workspace:core", version: "*" },
        },
      }),
    );

    const res = await runWorkspacesCommand({ cwd: rootDir });
    expect(res.workspaces.map((w) => w.name)).toEqual(["api", "core", "plugin"]);

    const byName = Object.fromEntries(res.workspaces.map((w) => [w.name, w]));
    expect(byName.api.role).toBe("internal");
    expect(byName.api.main).toBeNull();
    expect(byName.core.role).toBe("internal");
    expect(byName.core.dependsOn).toEqual(["api"]);
    expect(byName.plugin.role).toBe("shipping");
    expect(byName.plugin.main).toBe("com.example.Plugin");
    expect(byName.plugin.dependsOn).toContain("api");
    expect(byName.plugin.dependsOn).toContain("core");
  });

  test("output path uses forward slashes and bin/<name>-<version>.jar", async () => {
    await mkdir(join(rootDir, "api"), { recursive: true });
    await writeFile(
      join(rootDir, "project.json"),
      JSON.stringify({
        name: "suite",
        version: "1.0.0",
        compatibility: { versions: ["1.21"], platforms: ["paper"] },
        workspaces: ["./api"],
      }),
    );
    await writeFile(
      join(rootDir, "api", "project.json"),
      JSON.stringify({ name: "api", version: "0.1.0" }),
    );

    const res = await runWorkspacesCommand({ cwd: rootDir });
    expect(res.workspaces[0].outputPath).toMatch(/\/api\/bin\/api-0\.1\.0\.jar$/);
    expect(res.workspaces[0].outputPath.includes("\\")).toBe(false);
  });

  test("--json emits a single object on stdout with schemaVersion: 1", async () => {
    await mkdir(join(rootDir, "api"), { recursive: true });
    await writeFile(
      join(rootDir, "project.json"),
      JSON.stringify({
        name: "suite",
        version: "1.0.0",
        compatibility: { versions: ["1.21"], platforms: ["paper"] },
        workspaces: ["./api"],
      }),
    );
    await writeFile(
      join(rootDir, "api", "project.json"),
      JSON.stringify({ name: "api", version: "0.1.0", main: "a.M" }),
    );

    initLogging({ json: true });
    await runWorkspacesCommand({ cwd: rootDir });

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    const printed = stdoutSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(printed);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.workspaces).toHaveLength(1);
    expect(parsed.workspaces[0].name).toBe("api");
    expect(parsed.workspaces[0].role).toBe("shipping");
  });

  test("throws when not inside a pluggy project", async () => {
    await expect(runWorkspacesCommand({ cwd: rootDir })).rejects.toThrow(/no pluggy project/i);
  });
});
