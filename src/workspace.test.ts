/** Contract tests for workspace discovery and graph ops. */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";

import type { ResolvedProject } from "./project.ts";
import {
  findWorkspace,
  parseWorkspaceList,
  resolveWorkspaceContext,
  selectWorkspaceTargets,
  topologicalOrder,
  type WorkspaceContext,
  type WorkspaceNode,
} from "./workspace.ts";

describe("resolveWorkspaceContext", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "pluggy-ws-"));
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  test("standalone project: atRoot=true, no workspaces", async () => {
    await writeFile(
      join(rootDir, "project.json"),
      JSON.stringify({
        name: "standalone",
        version: "1.0.0",
        main: "com.example.Plugin",
        compatibility: { versions: ["1.21.8"], platforms: ["paper"] },
      }),
    );

    const ctx = resolveWorkspaceContext(rootDir);
    expect(ctx).toBeDefined();
    expect(ctx!.atRoot).toBe(true);
    expect(ctx!.workspaces).toEqual([]);
    expect(ctx!.current).toBeUndefined();
  });

  test("root with workspaces: atRoot=true at root, current set inside a workspace", async () => {
    await mkdir(join(rootDir, "modules", "api"), { recursive: true });
    await writeFile(
      join(rootDir, "project.json"),
      JSON.stringify({
        name: "suite",
        version: "1.0.0",
        compatibility: { versions: ["1.21.8"], platforms: ["paper"] },
        workspaces: ["./modules/api"],
      }),
    );
    await writeFile(
      join(rootDir, "modules", "api", "project.json"),
      JSON.stringify({
        name: "suite-api",
        version: "0.1.0",
        main: "com.example.api.Plugin",
      }),
    );

    const atRoot = resolveWorkspaceContext(rootDir);
    expect(atRoot!.atRoot).toBe(true);
    expect(atRoot!.workspaces).toHaveLength(1);
    expect(atRoot!.workspaces[0].name).toBe("suite-api");

    const inside = resolveWorkspaceContext(join(rootDir, "modules", "api"));
    expect(inside!.atRoot).toBe(false);
    expect(inside!.current?.name).toBe("suite-api");
  });

  test("workspace inherits compatibility from root when missing", async () => {
    await mkdir(join(rootDir, "modules", "api"), { recursive: true });
    await writeFile(
      join(rootDir, "project.json"),
      JSON.stringify({
        name: "suite",
        version: "1.0.0",
        compatibility: { versions: ["1.21.8"], platforms: ["paper"] },
        workspaces: ["./modules/api"],
      }),
    );
    await writeFile(
      join(rootDir, "modules", "api", "project.json"),
      JSON.stringify({
        name: "suite-api",
        version: "0.1.0",
        main: "com.example.api.Plugin",
      }),
    );

    const ctx = resolveWorkspaceContext(rootDir);
    expect(ctx!.workspaces[0].project.compatibility).toEqual({
      versions: ["1.21.8"],
      platforms: ["paper"],
    });
  });

  test("workspace compatibility override wins (deep replace, no array merging)", async () => {
    await mkdir(join(rootDir, "modules", "api"), { recursive: true });
    await writeFile(
      join(rootDir, "project.json"),
      JSON.stringify({
        name: "suite",
        version: "1.0.0",
        compatibility: { versions: ["1.21.8"], platforms: ["paper"] },
        workspaces: ["./modules/api"],
      }),
    );
    await writeFile(
      join(rootDir, "modules", "api", "project.json"),
      JSON.stringify({
        name: "suite-api",
        version: "0.1.0",
        main: "com.example.api.Plugin",
        compatibility: { versions: ["1.20.4"], platforms: ["spigot"] },
      }),
    );

    const ctx = resolveWorkspaceContext(rootDir);
    expect(ctx!.workspaces[0].project.compatibility).toEqual({
      versions: ["1.20.4"],
      platforms: ["spigot"],
    });
  });

  test("registries merge root-then-workspace and de-dupe by URL", async () => {
    await mkdir(join(rootDir, "modules", "impl"), { recursive: true });
    await writeFile(
      join(rootDir, "project.json"),
      JSON.stringify({
        name: "suite",
        version: "1.0.0",
        compatibility: { versions: ["1.21.8"], platforms: ["paper"] },
        registries: ["https://repo.root.example/", "https://shared.example/"],
        workspaces: ["./modules/impl"],
      }),
    );
    await writeFile(
      join(rootDir, "modules", "impl", "project.json"),
      JSON.stringify({
        name: "suite-impl",
        version: "0.1.0",
        main: "com.example.impl.Plugin",
        registries: ["https://shared.example/", "https://repo.ws.example/"],
      }),
    );

    const ctx = resolveWorkspaceContext(rootDir);
    expect(ctx!.workspaces[0].project.registries).toEqual([
      "https://repo.root.example/",
      "https://shared.example/",
      "https://repo.ws.example/",
    ]);
  });

  test("dependencies merge: root first, workspace wins on collision", async () => {
    await mkdir(join(rootDir, "modules", "core"), { recursive: true });
    await writeFile(
      join(rootDir, "project.json"),
      JSON.stringify({
        name: "suite",
        version: "1.0.0",
        compatibility: { versions: ["1.21.8"], platforms: ["paper"] },
        dependencies: {
          "paper-api": "1.21-R0.1-SNAPSHOT",
          shared: "1.0.0",
        },
        workspaces: ["./modules/core"],
      }),
    );
    await writeFile(
      join(rootDir, "modules", "core", "project.json"),
      JSON.stringify({
        name: "suite-core",
        version: "0.1.0",
        main: "com.example.core.Plugin",
        dependencies: {
          shared: "2.0.0",
          caffeine: "3.1.8",
        },
      }),
    );

    const ctx = resolveWorkspaceContext(rootDir);
    expect(ctx!.workspaces[0].project.dependencies).toEqual({
      "paper-api": "1.21-R0.1-SNAPSHOT",
      shared: "2.0.0",
      caffeine: "3.1.8",
    });
  });

  test("dependencies: null in workspace removes inherited entry", async () => {
    await mkdir(join(rootDir, "modules", "api"), { recursive: true });
    await writeFile(
      join(rootDir, "project.json"),
      JSON.stringify({
        name: "suite",
        version: "1.0.0",
        compatibility: { versions: ["1.21.8"], platforms: ["paper"] },
        dependencies: {
          "paper-api": "1.21-R0.1-SNAPSHOT",
          caffeine: "3.1.8",
        },
        workspaces: ["./modules/api"],
      }),
    );
    await writeFile(
      join(rootDir, "modules", "api", "project.json"),
      JSON.stringify({
        name: "suite-api",
        version: "0.1.0",
        main: "com.example.api.Plugin",
        dependencies: { caffeine: null },
      }),
    );

    const ctx = resolveWorkspaceContext(rootDir);
    expect(ctx!.workspaces[0].project.dependencies).toEqual({
      "paper-api": "1.21-R0.1-SNAPSHOT",
    });
  });

  test("dependencies: undefined when neither root nor workspace declares any", async () => {
    await mkdir(join(rootDir, "modules", "api"), { recursive: true });
    await writeFile(
      join(rootDir, "project.json"),
      JSON.stringify({
        name: "suite",
        version: "1.0.0",
        compatibility: { versions: ["1.21.8"], platforms: ["paper"] },
        workspaces: ["./modules/api"],
      }),
    );
    await writeFile(
      join(rootDir, "modules", "api", "project.json"),
      JSON.stringify({
        name: "suite-api",
        version: "0.1.0",
        main: "com.example.api.Plugin",
      }),
    );

    const ctx = resolveWorkspaceContext(rootDir);
    expect(ctx!.workspaces[0].project.dependencies).toBeUndefined();
  });

  test("jdk inherits from root when workspace omits it", async () => {
    await mkdir(join(rootDir, "modules", "api"), { recursive: true });
    await writeFile(
      join(rootDir, "project.json"),
      JSON.stringify({
        name: "suite",
        version: "1.0.0",
        compatibility: { versions: ["1.21.8"], platforms: ["paper"] },
        jdk: { major: 21, distribution: "temurin" },
        workspaces: ["./modules/api"],
      }),
    );
    await writeFile(
      join(rootDir, "modules", "api", "project.json"),
      JSON.stringify({
        name: "suite-api",
        version: "0.1.0",
        main: "com.example.api.Plugin",
      }),
    );

    const ctx = resolveWorkspaceContext(rootDir);
    expect(ctx!.workspaces[0].project.jdk).toEqual({ major: 21, distribution: "temurin" });
  });

  test("workspace jdk overrides inherited root jdk", async () => {
    await mkdir(join(rootDir, "modules", "api"), { recursive: true });
    await writeFile(
      join(rootDir, "project.json"),
      JSON.stringify({
        name: "suite",
        version: "1.0.0",
        compatibility: { versions: ["1.21.8"], platforms: ["paper"] },
        jdk: { major: 21 },
        workspaces: ["./modules/api"],
      }),
    );
    await writeFile(
      join(rootDir, "modules", "api", "project.json"),
      JSON.stringify({
        name: "suite-api",
        version: "0.1.0",
        main: "com.example.api.Plugin",
        jdk: { major: 17 },
      }),
    );

    const ctx = resolveWorkspaceContext(rootDir);
    expect(ctx!.workspaces[0].project.jdk).toEqual({ major: 17 });
  });

  test("version is not inherited", async () => {
    await mkdir(join(rootDir, "modules", "api"), { recursive: true });
    await writeFile(
      join(rootDir, "project.json"),
      JSON.stringify({
        name: "suite",
        version: "9.9.9",
        compatibility: { versions: ["1.21.8"], platforms: ["paper"] },
        workspaces: ["./modules/api"],
      }),
    );
    await writeFile(
      join(rootDir, "modules", "api", "project.json"),
      JSON.stringify({
        name: "suite-api",
        version: "0.1.0",
        main: "com.example.api.Plugin",
      }),
    );

    const ctx = resolveWorkspaceContext(rootDir);
    expect(ctx!.workspaces[0].project.version).toBe("0.1.0");
  });

  test("returns undefined when cwd is not inside any project", async () => {
    expect(resolveWorkspaceContext(rootDir)).toBeUndefined();
  });
});

describe("topologicalOrder", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "pluggy-ws-topo-"));
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  test("orders dependent workspaces after their dependencies", async () => {
    await mkdir(join(rootDir, "modules", "api"), { recursive: true });
    await mkdir(join(rootDir, "modules", "impl"), { recursive: true });
    await writeFile(
      join(rootDir, "project.json"),
      JSON.stringify({
        name: "suite",
        version: "1.0.0",
        compatibility: { versions: ["1.21.8"], platforms: ["paper"] },
        workspaces: ["./modules/impl", "./modules/api"],
      }),
    );
    await writeFile(
      join(rootDir, "modules", "api", "project.json"),
      JSON.stringify({
        name: "suite-api",
        version: "0.1.0",
        main: "com.example.api.Plugin",
      }),
    );
    await writeFile(
      join(rootDir, "modules", "impl", "project.json"),
      JSON.stringify({
        name: "suite-impl",
        version: "0.1.0",
        main: "com.example.impl.Plugin",
        dependencies: {
          "suite-api": { source: "workspace:suite-api", version: "*" },
        },
      }),
    );

    const ctx = resolveWorkspaceContext(rootDir);
    const ordered = topologicalOrder(ctx!.workspaces);
    const names = ordered.map((w) => w.name);
    expect(names).toEqual(["suite-api", "suite-impl"]);
  });

  test("throws a descriptive error on cycles", async () => {
    await mkdir(join(rootDir, "a"), { recursive: true });
    await mkdir(join(rootDir, "b"), { recursive: true });
    await writeFile(
      join(rootDir, "project.json"),
      JSON.stringify({
        name: "suite",
        version: "1.0.0",
        compatibility: { versions: ["1.21.8"], platforms: ["paper"] },
        workspaces: ["./a", "./b"],
      }),
    );
    await writeFile(
      join(rootDir, "a", "project.json"),
      JSON.stringify({
        name: "ws-a",
        version: "0.1.0",
        main: "com.example.a.Plugin",
        dependencies: { "ws-b": { source: "workspace:ws-b", version: "*" } },
      }),
    );
    await writeFile(
      join(rootDir, "b", "project.json"),
      JSON.stringify({
        name: "ws-b",
        version: "0.1.0",
        main: "com.example.b.Plugin",
        dependencies: { "ws-a": { source: "workspace:ws-a", version: "*" } },
      }),
    );

    const ctx = resolveWorkspaceContext(rootDir);
    expect(() => topologicalOrder(ctx!.workspaces)).toThrow(/cycle/i);
  });

  test("non-workspace deps (modrinth) do not influence ordering", async () => {
    await mkdir(join(rootDir, "a"), { recursive: true });
    await mkdir(join(rootDir, "b"), { recursive: true });
    await writeFile(
      join(rootDir, "project.json"),
      JSON.stringify({
        name: "suite",
        version: "1.0.0",
        compatibility: { versions: ["1.21.8"], platforms: ["paper"] },
        workspaces: ["./a", "./b"],
      }),
    );
    await writeFile(
      join(rootDir, "a", "project.json"),
      JSON.stringify({
        name: "ws-a",
        version: "0.1.0",
        main: "com.example.a.Plugin",
        dependencies: {
          worldedit: { source: "modrinth:worldedit", version: "7.3.15" },
        },
      }),
    );
    await writeFile(
      join(rootDir, "b", "project.json"),
      JSON.stringify({
        name: "ws-b",
        version: "0.1.0",
        main: "com.example.b.Plugin",
      }),
    );

    const ctx = resolveWorkspaceContext(rootDir);
    const ordered = topologicalOrder(ctx!.workspaces);
    // Both leaf nodes; declaration order preserved.
    expect(ordered.map((w) => w.name)).toEqual(["ws-a", "ws-b"]);
  });

  test("empty input returns empty output", () => {
    expect(topologicalOrder([])).toEqual([]);
  });
});

describe("parseWorkspaceList", () => {
  test("single value passes through unchanged", () => {
    expect(parseWorkspaceList(["api"])).toEqual(["api"]);
  });

  test("repeated flag values combine in order", () => {
    expect(parseWorkspaceList(["api", "core"])).toEqual(["api", "core"]);
  });

  test("comma-separated values split", () => {
    expect(parseWorkspaceList(["api,core"])).toEqual(["api", "core"]);
  });

  test("mixed repeat + comma combine into one list", () => {
    expect(parseWorkspaceList(["api,core", "paper"])).toEqual(["api", "core", "paper"]);
  });

  test("deduplicates while preserving first-occurrence order", () => {
    expect(parseWorkspaceList(["api", "api,core", "api"])).toEqual(["api", "core"]);
  });

  test("trims whitespace and drops empty parts", () => {
    expect(parseWorkspaceList(["api, core, "])).toEqual(["api", "core"]);
    expect(parseWorkspaceList(["api,,core"])).toEqual(["api", "core"]);
  });

  test("empty input → empty output", () => {
    expect(parseWorkspaceList([])).toEqual([]);
    expect(parseWorkspaceList([""])).toEqual([]);
  });
});

describe("selectWorkspaceTargets", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "pluggy-select-"));
  });
  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  async function writeTrio(): Promise<void> {
    await mkdir(join(rootDir, "api"), { recursive: true });
    await mkdir(join(rootDir, "core"), { recursive: true });
    await mkdir(join(rootDir, "plugin"), { recursive: true });
    await writeFile(
      join(rootDir, "project.json"),
      JSON.stringify({
        name: "suite",
        version: "1.0.0",
        compatibility: { versions: ["1.21.8"], platforms: ["paper"] },
        workspaces: ["./api", "./core", "./plugin"],
      }),
    );
    await writeFile(
      join(rootDir, "api", "project.json"),
      JSON.stringify({ name: "api", version: "0.1.0", main: "a.M" }),
    );
    await writeFile(
      join(rootDir, "core", "project.json"),
      JSON.stringify({
        name: "core",
        version: "0.1.0",
        main: "c.M",
        dependencies: { api: { source: "workspace:api", version: "*" } },
      }),
    );
    await writeFile(
      join(rootDir, "plugin", "project.json"),
      JSON.stringify({
        name: "plugin",
        version: "0.1.0",
        main: "p.M",
        dependencies: {
          api: { source: "workspace:api", version: "*" },
          core: { source: "workspace:core", version: "*" },
        },
      }),
    );
  }

  test("default sweep returns all in topo order", async () => {
    await writeTrio();
    const ctx = resolveWorkspaceContext(rootDir)!;
    const targets = selectWorkspaceTargets(ctx, {}, "build");
    expect(targets.map((t) => t.name)).toEqual(["api", "core", "plugin"]);
  });

  test("multi-value --workspace narrows to listed names", async () => {
    await writeTrio();
    const ctx = resolveWorkspaceContext(rootDir)!;
    const targets = selectWorkspaceTargets(ctx, { workspace: ["api", "core"] }, "build");
    expect(targets.map((t) => t.name)).toEqual(["api", "core"]);
  });

  test("--exclude removes from the default sweep", async () => {
    await writeTrio();
    const ctx = resolveWorkspaceContext(rootDir)!;
    const targets = selectWorkspaceTargets(ctx, { exclude: ["plugin"] }, "build");
    expect(targets.map((t) => t.name)).toEqual(["api", "core"]);
  });

  test("excluding a workspace whose dependents are kept fails fast", async () => {
    await writeTrio();
    const ctx = resolveWorkspaceContext(rootDir)!;
    expect(() => selectWorkspaceTargets(ctx, { exclude: ["core"] }, "build")).toThrow(
      /"plugin" depends on "core"/,
    );
  });

  test("--workspace + --exclude with the same name → empty error", async () => {
    await writeTrio();
    const ctx = resolveWorkspaceContext(rootDir)!;
    expect(() =>
      selectWorkspaceTargets(ctx, { workspace: ["api"], exclude: ["api"] }, "build"),
    ).toThrow(/selection is empty/);
  });

  test("--exclude with unknown name throws the known-names error", async () => {
    await writeTrio();
    const ctx = resolveWorkspaceContext(rootDir)!;
    expect(() => selectWorkspaceTargets(ctx, { exclude: ["nope"] }, "build")).toThrow(
      /workspace not found/,
    );
  });

  test("--exclude inside a workspace is rejected", async () => {
    await writeTrio();
    const ctx = resolveWorkspaceContext(join(rootDir, "api"))!;
    expect(() => selectWorkspaceTargets(ctx, { exclude: ["core"] }, "build")).toThrow(
      /--exclude is only valid at the repo root/,
    );
  });
});

describe("findWorkspace", () => {
  const makeNode = (name: string): WorkspaceNode => ({
    name,
    root: `/tmp/${name}`,
    project: {
      name,
      version: "0.1.0",
      main: `com.example.${name}.Plugin`,
      compatibility: { versions: ["1.21.8"], platforms: ["paper"] },
      rootDir: `/tmp/${name}`,
      projectFile: `/tmp/${name}/project.json`,
    } as ResolvedProject,
  });

  const context: WorkspaceContext = {
    root: {
      name: "suite",
      version: "1.0.0",
      compatibility: { versions: ["1.21.8"], platforms: ["paper"] },
      rootDir: "/tmp/suite",
      projectFile: "/tmp/suite/project.json",
    } as ResolvedProject,
    atRoot: true,
    current: undefined,
    workspaces: [makeNode("suite-api"), makeNode("suite-impl")],
  };

  test("returns the matching workspace", () => {
    expect(findWorkspace(context, "suite-impl").name).toBe("suite-impl");
  });

  test("throws with the list of known names when not found", () => {
    expect(() => findWorkspace(context, "suite-addon")).toThrow(/suite-addon/);
    expect(() => findWorkspace(context, "suite-addon")).toThrow(
      /suite-api.*suite-impl|suite-impl.*suite-api/,
    );
  });

  test("lists (none) when there are no workspaces", () => {
    const empty: WorkspaceContext = { ...context, workspaces: [] };
    expect(() => findWorkspace(empty, "anything")).toThrow(/\(none\)/);
  });
});
