/** Contract tests for `pluggy workspace add`. */

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";

import { initLogging } from "../logging.ts";
import { resolveProjectFile, type Project } from "../project.ts";
import { runWorkspaceAdd, runWorkspaceRemove, runWorkspaceRename } from "./workspace.ts";

describe("runWorkspaceAdd", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "pluggy-ws-add-"));
    initLogging({ json: false, verbose: false, noColor: true });
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  async function writeRoot(extra?: Partial<Project>): Promise<void> {
    await writeFile(
      join(rootDir, "project.json"),
      JSON.stringify({
        name: "suite",
        version: "1.0.0",
        compatibility: { versions: ["1.21"], platforms: ["paper"] },
        workspaces: [],
        ...extra,
      }),
    );
  }

  test("scaffolds folder + project.json and updates root's workspaces array", async () => {
    await writeRoot();
    const res = await runWorkspaceAdd({ cwd: rootDir, name: "core" });

    expect(res.status).toBe("success");
    expect(res.name).toBe("core");

    const child = resolveProjectFile(join(rootDir, "core", "project.json"));
    expect(child).toBeDefined();
    expect(child?.name).toBe("core");
    expect(child?.version).toBe("0.1.0");
    expect(child?.main).toBeUndefined();

    const root = resolveProjectFile(join(rootDir, "project.json"));
    expect(root?.workspaces).toEqual(["./core"]);
  });

  test("writes child project.json BEFORE updating root array", async () => {
    await writeRoot();
    // Crash recovery property: even if the run fails between steps, the child
    // file is written first. We can't actually test mid-flight crash here, but
    // we can confirm the order via file modification times.
    const res = await runWorkspaceAdd({ cwd: rootDir, name: "api" });

    const childStat = await stat(res.projectFile);
    const rootStat = await stat(res.rootProjectFile);
    expect(childStat.mtimeMs).toBeLessThanOrEqual(rootStat.mtimeMs);
  });

  test("--main scaffolds a Java source stub at the matching package path", async () => {
    await writeRoot();
    await runWorkspaceAdd({
      cwd: rootDir,
      name: "plugin",
      main: "com.example.plugin.MyPlugin",
    });

    const javaPath = join(rootDir, "plugin", "src", "com", "example", "plugin", "MyPlugin.java");
    const source = await readFile(javaPath, "utf8");
    expect(source).toContain("package com.example.plugin;");
    expect(source).toContain("public class MyPlugin");
  });

  test("--platforms overrides; otherwise compatibility is omitted to inherit", async () => {
    await writeRoot();
    await runWorkspaceAdd({ cwd: rootDir, name: "inh" });
    const inh = resolveProjectFile(join(rootDir, "inh", "project.json"));
    expect(inh?.compatibility).toBeUndefined();

    await runWorkspaceAdd({
      cwd: rootDir,
      name: "ovr",
      platforms: ["sponge"],
    });
    const ovr = resolveProjectFile(join(rootDir, "ovr", "project.json"));
    expect(ovr?.compatibility?.platforms).toEqual(["sponge"]);
  });

  test("--depends wires workspace:<name> deps", async () => {
    await writeRoot();
    await runWorkspaceAdd({
      cwd: rootDir,
      name: "plugin",
      depends: ["api", "core"],
    });

    const child = resolveProjectFile(join(rootDir, "plugin", "project.json"));
    expect(child?.dependencies).toEqual({
      api: { source: "workspace:api", version: "*" },
      core: { source: "workspace:core", version: "*" },
    });
  });

  test("rejects invalid names", async () => {
    await writeRoot();
    await expect(runWorkspaceAdd({ cwd: rootDir, name: "1bad" })).rejects.toThrow(/invalid/);
    await expect(runWorkspaceAdd({ cwd: rootDir, name: "../bad" })).rejects.toThrow(/invalid/);
    await expect(runWorkspaceAdd({ cwd: rootDir, name: "bad name" })).rejects.toThrow(/invalid/);
  });

  test("rejects --dir that escapes the root", async () => {
    await writeRoot();
    await expect(runWorkspaceAdd({ cwd: rootDir, name: "api", dir: "../sibling" })).rejects.toThrow(
      /escape/i,
    );
  });

  test("rejects collision with an existing workspace name", async () => {
    await writeRoot();
    await mkdir(join(rootDir, "api"), { recursive: true });
    await writeFile(
      join(rootDir, "api", "project.json"),
      JSON.stringify({ name: "api", version: "0.1.0" }),
    );
    await writeFile(
      join(rootDir, "project.json"),
      JSON.stringify({
        name: "suite",
        version: "1.0.0",
        compatibility: { versions: ["1.21"], platforms: ["paper"] },
        workspaces: ["./api"],
      }),
    );

    await expect(runWorkspaceAdd({ cwd: rootDir, name: "api", dir: "./api2" })).rejects.toThrow(
      /already declared/,
    );
  });

  test("rejects when target directory already exists", async () => {
    await writeRoot();
    await mkdir(join(rootDir, "api"), { recursive: true });
    await expect(runWorkspaceAdd({ cwd: rootDir, name: "api" })).rejects.toThrow(/already exists/);
  });

  test("throws when not inside any pluggy project", async () => {
    await expect(runWorkspaceAdd({ cwd: rootDir, name: "x" })).rejects.toThrow(
      /no pluggy project/i,
    );
  });
});

describe("runWorkspaceRemove", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "pluggy-ws-rm-"));
    initLogging({ json: false, verbose: false, noColor: true });
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  async function writeWithApiCore(): Promise<void> {
    await mkdir(join(rootDir, "api"), { recursive: true });
    await mkdir(join(rootDir, "core"), { recursive: true });
    await writeFile(
      join(rootDir, "project.json"),
      JSON.stringify({
        name: "suite",
        version: "1.0.0",
        compatibility: { versions: ["1.21"], platforms: ["paper"] },
        workspaces: ["./api", "./core"],
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
  }

  test("unwires the workspace from root but leaves files by default", async () => {
    await writeWithApiCore();
    // Remove `core` (no dependents).
    const res = await runWorkspaceRemove({ cwd: rootDir, name: "core" });
    expect(res.status).toBe("success");
    expect(res.deletedFiles).toBe(false);

    const root = resolveProjectFile(join(rootDir, "project.json"));
    expect(root?.workspaces).toEqual(["./api"]);
    // Files should still be there.
    const child = resolveProjectFile(join(rootDir, "core", "project.json"));
    expect(child).toBeDefined();
  });

  test("--delete also removes the workspace's directory", async () => {
    await writeWithApiCore();
    const res = await runWorkspaceRemove({ cwd: rootDir, name: "core", deleteFiles: true });
    expect(res.deletedFiles).toBe(true);
    expect(resolveProjectFile(join(rootDir, "core", "project.json"))).toBeUndefined();
  });

  test("refuses when other workspaces declare workspace:<name>", async () => {
    await writeWithApiCore();
    await expect(runWorkspaceRemove({ cwd: rootDir, name: "api" })).rejects.toThrow(
      /workspaces "core" depend on it/,
    );
  });

  test("--force overrides the dependents check", async () => {
    await writeWithApiCore();
    const res = await runWorkspaceRemove({ cwd: rootDir, name: "api", force: true });
    expect(res.status).toBe("success");
    const root = resolveProjectFile(join(rootDir, "project.json"));
    expect(root?.workspaces).toEqual(["./core"]);
  });

  test("unknown workspace name throws", async () => {
    await writeWithApiCore();
    await expect(runWorkspaceRemove({ cwd: rootDir, name: "nope" })).rejects.toThrow(
      /not declared/,
    );
  });
});

describe("runWorkspaceRename", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "pluggy-ws-rn-"));
    initLogging({ json: false, verbose: false, noColor: true });
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  async function writeWithApiCore(): Promise<void> {
    await mkdir(join(rootDir, "api"), { recursive: true });
    await mkdir(join(rootDir, "core"), { recursive: true });
    await writeFile(
      join(rootDir, "project.json"),
      JSON.stringify({
        name: "suite",
        version: "1.0.0",
        compatibility: { versions: ["1.21"], platforms: ["paper"] },
        workspaces: ["./api", "./core"],
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
  }

  test("renames the workspace and rewrites sibling deps", async () => {
    await writeWithApiCore();
    const res = await runWorkspaceRename({ cwd: rootDir, oldName: "api", newName: "shared" });
    expect(res.status).toBe("success");
    expect(res.dependentsRewritten).toBe(1);

    const renamed = resolveProjectFile(join(rootDir, "api", "project.json"));
    expect(renamed?.name).toBe("shared");

    const core = resolveProjectFile(join(rootDir, "core", "project.json"));
    expect(core?.dependencies).toEqual({
      shared: { source: "workspace:shared", version: "*" },
    });
  });

  test("refuses when new name already exists", async () => {
    await writeWithApiCore();
    await expect(
      runWorkspaceRename({ cwd: rootDir, oldName: "api", newName: "core" }),
    ).rejects.toThrow(/already exists/);
  });

  test("rejects invalid new names", async () => {
    await writeWithApiCore();
    await expect(
      runWorkspaceRename({ cwd: rootDir, oldName: "api", newName: "../bad" }),
    ).rejects.toThrow(/invalid/);
  });

  test("unknown old name throws", async () => {
    await writeWithApiCore();
    await expect(
      runWorkspaceRename({ cwd: rootDir, oldName: "nope", newName: "fine" }),
    ).rejects.toThrow(/not declared/);
  });

  test("same-name is a no-op error", async () => {
    await writeWithApiCore();
    await expect(
      runWorkspaceRename({ cwd: rootDir, oldName: "api", newName: "api" }),
    ).rejects.toThrow(/same as the old name/);
  });

  test("refuses when the new name collides with an unrelated dep key in a sibling", async () => {
    // Set up: core depends on workspace:api AND has an unrelated dep keyed
    // as "shared" (a modrinth slug, not a workspace ref). Renaming api →
    // shared would silently overwrite that modrinth dep.
    await writeWithApiCore();
    await writeFile(
      join(rootDir, "core", "project.json"),
      JSON.stringify({
        name: "core",
        version: "0.1.0",
        dependencies: {
          api: { source: "workspace:api", version: "*" },
          shared: { source: "modrinth:shared-utils", version: "1.0.0" },
        },
      }),
    );

    await expect(
      runWorkspaceRename({ cwd: rootDir, oldName: "api", newName: "shared" }),
    ).rejects.toThrow(/collides with existing dep declarations/);

    // The renamed workspace's own project.name must NOT have been written:
    // the pre-flight runs before any mutation.
    const apiProject = resolveProjectFile(join(rootDir, "api", "project.json"));
    expect(apiProject?.name).toBe("api");
  });

  test("allows rename when the new name happens to equal the old dep key (idempotent)", async () => {
    // core declares the workspace:api dep keyed as "api" (the conventional
    // shape). Renaming api → api2 still has "api2" free in core's deps, so
    // it proceeds normally. Sanity check that the pre-flight doesn't
    // false-positive on the key it's about to write.
    await writeWithApiCore();
    const res = await runWorkspaceRename({ cwd: rootDir, oldName: "api", newName: "api2" });
    expect(res.status).toBe("success");
    expect(res.dependentsRewritten).toBe(1);
  });
});
