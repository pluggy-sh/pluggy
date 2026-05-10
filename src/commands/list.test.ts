/** Tests for src/commands/list.ts. Uses a tmpdir-backed project tree. */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import { initLogging } from "../logging.ts";
import { doList } from "./list.ts";

const origLog = console.log;
const origWarn = console.warn;
beforeEach(() => {
  console.log = () => {};
  console.warn = () => {};
  initLogging({ json: false, verbose: false, noColor: true });
});
afterEach(() => {
  console.log = origLog;
  console.warn = origWarn;
  vi.unstubAllGlobals();
  initLogging({ json: false, verbose: false, noColor: true });
});

describe("doList: standalone", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "pluggy-list-std-"));
  });
  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  test("lists deps from a standalone project with declared + resolved versions", async () => {
    await writeFile(
      join(rootDir, "project.json"),
      JSON.stringify({
        name: "my_plugin",
        version: "1.0.0",
        main: "com.example.Plugin",
        compatibility: { versions: ["1.21.8"], platforms: ["paper"] },
        dependencies: {
          worldedit: "7.3.15",
          customlib: { source: "file:./libs/custom.jar", version: "1.0.0" },
        },
        registries: [
          "https://repo1.maven.org/maven2/",
          {
            url: "https://private.example.com/maven",
            credentials: { username: "u", password: "p" },
          },
        ],
      }),
    );
    await writeFile(
      join(rootDir, "pluggy.lock"),
      JSON.stringify({
        version: 2,
        entries: {
          worldedit: {
            source: { kind: "modrinth", slug: "worldedit", version: "7.3.15" },
            resolvedVersion: "7.3.15",
            integrity: "sha256-abc",
            declaredBy: ["my_plugin"],
          },
        },
      }),
    );

    const result = await doList({ cwd: rootDir });
    expect(result.scope).toBe("standalone");
    expect(result.deps).toHaveLength(2);

    const byName = Object.fromEntries(result.deps.map((d) => [d.name, d]));
    expect(byName.worldedit.resolvedVersion).toBe("7.3.15");
    expect(byName.worldedit.source.kind).toBe("modrinth");
    expect(byName.customlib.resolvedVersion).toBeNull();
    expect(byName.customlib.source.kind).toBe("file");

    expect(result.registries).toHaveLength(2);
    const authRegistry = result.registries.find((r) => r.url.includes("private"))!;
    expect(authRegistry.authenticated).toBe(true);
    // Credentials must be elided; JSON output feeds CI logs.
    expect(JSON.stringify(result.registries)).not.toContain("password");
    expect(JSON.stringify(result.registries)).not.toContain("secret");
  });

  test("handles empty dependencies gracefully", async () => {
    await writeFile(
      join(rootDir, "project.json"),
      JSON.stringify({
        name: "my_plugin",
        version: "1.0.0",
        main: "com.example.Plugin",
        compatibility: { versions: ["1.21.8"], platforms: ["paper"] },
      }),
    );
    const result = await doList({ cwd: rootDir });
    expect(result.deps).toEqual([]);
  });
});

describe("doList: root with workspaces", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "pluggy-list-root-"));
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
        name: "suite-api",
        version: "0.1.0",
        main: "com.example.api.Plugin",
        dependencies: { placeholderapi: "2.11.6" },
      }),
    );
    await writeFile(
      join(rootDir, "modules", "impl", "project.json"),
      JSON.stringify({
        name: "suite-impl",
        version: "0.1.0",
        main: "com.example.impl.Plugin",
        dependencies: { placeholderapi: "2.11.6", worldedit: "7.3.15" },
      }),
    );
  });
  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  test("at root: aggregates across all workspaces and tracks declaredBy", async () => {
    const result = await doList({ cwd: rootDir });
    expect(result.scope).toBe("root");
    expect(result.deps.map((d) => d.name).sort()).toEqual(["placeholderapi", "worldedit"]);

    const placeholder = result.deps.find((d) => d.name === "placeholderapi")!;
    expect(placeholder.declaredBy.sort()).toEqual(["suite-api", "suite-impl"]);
    const worldedit = result.deps.find((d) => d.name === "worldedit")!;
    expect(worldedit.declaredBy).toEqual(["suite-impl"]);
  });

  test("--workspace <name> narrows to a single workspace", async () => {
    const result = await doList({ cwd: rootDir, workspace: "suite-api" });
    expect(result.scope).toBe("workspace");
    expect(result.deps.map((d) => d.name)).toEqual(["placeholderapi"]);
  });

  test("inside a workspace, defaults to that workspace's deps only", async () => {
    const insideCwd = join(rootDir, "modules", "impl");
    const result = await doList({ cwd: insideCwd });
    expect(result.scope).toBe("workspace");
    expect(result.deps.map((d) => d.name).sort()).toEqual(["placeholderapi", "worldedit"]);
  });
});

describe("doList: flag placeholders", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "pluggy-list-flags-"));
    await writeFile(
      join(rootDir, "project.json"),
      JSON.stringify({
        name: "my_plugin",
        version: "1.0.0",
        main: "com.example.Plugin",
        compatibility: { versions: ["1.21.8"], platforms: ["paper"] },
        dependencies: { worldedit: "7.3.15" },
      }),
    );
  });
  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  test("--outdated does not crash and returns the same deps", async () => {
    const result = await doList({ cwd: rootDir, outdated: true });
    expect(result.deps).toHaveLength(1);
  });

  test("--tree does not crash and returns the same deps", async () => {
    const result = await doList({ cwd: rootDir, tree: true });
    expect(result.deps).toHaveLength(1);
  });
});

describe("doList: tree surfaces lockfile transitives", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "pluggy-list-tree-"));
  });
  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  test("populates DepEntry.children recursively from the lockfile transitives tree", async () => {
    await writeFile(
      join(rootDir, "project.json"),
      JSON.stringify({
        name: "my_plugin",
        version: "1.0.0",
        main: "com.example.Plugin",
        compatibility: { versions: ["1.21.8"], platforms: ["paper"] },
        dependencies: {
          "paper-api": {
            source: "maven:io.papermc.paper:paper-api",
            version: "1.21.8-R0.1-SNAPSHOT",
          },
        },
      }),
    );
    await writeFile(
      join(rootDir, "pluggy.lock"),
      JSON.stringify({
        version: 2,
        entries: {
          "paper-api": {
            source: {
              kind: "maven",
              groupId: "io.papermc.paper",
              artifactId: "paper-api",
              version: "1.21.8-R0.1-SNAPSHOT",
            },
            resolvedVersion: "1.21.8-R0.1-SNAPSHOT",
            integrity: "sha256-paper",
            declaredBy: ["my_plugin"],
            transitives: ["net.kyori:adventure-api", "com.google.guava:guava"],
          },
          "net.kyori:adventure-api": {
            source: {
              kind: "maven",
              groupId: "net.kyori",
              artifactId: "adventure-api",
              version: "4.14.0",
            },
            resolvedVersion: "4.14.0",
            integrity: "sha256-adv",
            declaredBy: [],
            transitives: ["net.kyori:examination-api"],
          },
          "net.kyori:examination-api": {
            source: {
              kind: "maven",
              groupId: "net.kyori",
              artifactId: "examination-api",
              version: "1.3.0",
            },
            resolvedVersion: "1.3.0",
            integrity: "sha256-exam",
            declaredBy: [],
          },
          "com.google.guava:guava": {
            source: {
              kind: "maven",
              groupId: "com.google.guava",
              artifactId: "guava",
              version: "32.1.2",
            },
            resolvedVersion: "32.1.2",
            integrity: "sha256-guava",
            declaredBy: [],
          },
        },
      }),
    );

    const result = await doList({ cwd: rootDir, tree: true });
    expect(result.deps).toHaveLength(1);

    const top = result.deps[0];
    expect(top.name).toBe("paper-api");
    expect(top.children).toBeDefined();
    expect(top.children).toHaveLength(2);

    const adventure = top.children!.find((c) => c.name === "net.kyori:adventure-api")!;
    expect(adventure).toBeDefined();
    expect(adventure.source.kind).toBe("maven");
    expect(adventure.resolvedVersion).toBe("4.14.0");
    expect(adventure.declaredBy).toEqual([]);
    expect(adventure.children).toHaveLength(1);
    expect(adventure.children![0].name).toBe("net.kyori:examination-api");
    expect(adventure.children![0].resolvedVersion).toBe("1.3.0");
    expect(adventure.children![0].children).toBeUndefined();

    const guava = top.children!.find((c) => c.name === "com.google.guava:guava")!;
    expect(guava).toBeDefined();
    expect(guava.children).toBeUndefined();
  });

  test("leaves children undefined when lockfile entry has no transitives", async () => {
    await writeFile(
      join(rootDir, "project.json"),
      JSON.stringify({
        name: "my_plugin",
        version: "1.0.0",
        main: "com.example.Plugin",
        compatibility: { versions: ["1.21.8"], platforms: ["paper"] },
        dependencies: { worldedit: "7.3.15" },
      }),
    );
    await writeFile(
      join(rootDir, "pluggy.lock"),
      JSON.stringify({
        version: 2,
        entries: {
          worldedit: {
            source: { kind: "modrinth", slug: "worldedit", version: "7.3.15" },
            resolvedVersion: "7.3.15",
            integrity: "sha256-abc",
            declaredBy: ["my_plugin"],
          },
        },
      }),
    );

    const result = await doList({ cwd: rootDir, tree: true });
    expect(result.deps).toHaveLength(1);
    expect(result.deps[0].children).toBeUndefined();
  });
});
