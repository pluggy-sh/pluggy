/** Tests for src/commands/remove.ts. Real filesystem, no network. */

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";

import { readLock } from "../lockfile.ts";

import { doRemove } from "./remove.ts";

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

describe("doRemove", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pluggy-remove-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("happy path: standalone project → removes from project.json and pluggy.lock", async () => {
    await writeJson(join(dir, "project.json"), {
      name: "demo",
      version: "1.0.0",
      main: "com.example.Main",
      compatibility: { versions: ["1.21.8"], platforms: ["paper"] },
      dependencies: { worldedit: "7.3.15", keepme: "1.0.0" },
    });
    await writeJson(join(dir, "pluggy.lock"), {
      version: 2,
      entries: {
        worldedit: {
          source: { kind: "modrinth", slug: "worldedit", version: "7.3.15" },
          resolvedVersion: "7.3.15",
          integrity: "sha256-abc",
          declaredBy: ["demo"],
        },
        keepme: {
          source: { kind: "modrinth", slug: "keepme", version: "1.0.0" },
          resolvedVersion: "1.0.0",
          integrity: "sha256-def",
          declaredBy: ["demo"],
        },
      },
    });

    const result = await doRemove({ cwd: dir, plugin: "worldedit" });
    expect(result.removed).toEqual(["demo"]);
    expect(result.lockEntryRemoved).toBe(true);

    const project = JSON.parse(await readFile(join(dir, "project.json"), "utf8"));
    expect(project.dependencies.worldedit).toBeUndefined();
    expect(project.dependencies.keepme).toBe("1.0.0");

    const lock = readLock(dir);
    expect(lock?.entries.worldedit).toBeUndefined();
    expect(lock?.entries.keepme).toBeDefined();
  });

  test("at a root with workspaces and no --workspace/--workspaces → throws", async () => {
    await mkdir(join(dir, "modules", "api"), { recursive: true });
    await writeJson(join(dir, "project.json"), {
      name: "suite",
      version: "1.0.0",
      compatibility: { versions: ["1.21.8"], platforms: ["paper"] },
      workspaces: ["./modules/api"],
    });
    await writeJson(join(dir, "modules", "api", "project.json"), {
      name: "suite-api",
      version: "0.1.0",
      main: "com.example.api.Plugin",
      dependencies: { worldedit: "7.3.15" },
    });

    await expect(doRemove({ cwd: dir, plugin: "worldedit" })).rejects.toThrow(
      /workspace root|disambiguate/,
    );
  });

  test("--keep-file skips jar deletion", async () => {
    const jarPath = join(dir, "libs", "custom.jar");
    await mkdir(join(dir, "libs"), { recursive: true });
    await writeFile(jarPath, "fake jar bytes");

    await writeJson(join(dir, "project.json"), {
      name: "demo",
      version: "1.0.0",
      main: "com.example.Main",
      compatibility: { versions: ["1.21.8"], platforms: ["paper"] },
      dependencies: {
        custom: { source: "file:./libs/custom.jar", version: "1.0.0" },
      },
    });
    await writeJson(join(dir, "pluggy.lock"), {
      version: 2,
      entries: {
        custom: {
          source: { kind: "file", path: jarPath, version: "1.0.0" },
          resolvedVersion: "1.0.0",
          integrity: "sha256-file",
          declaredBy: ["demo"],
        },
      },
    });

    const result = await doRemove({ cwd: dir, plugin: "custom", keepFile: true });
    expect(result.removed).toEqual(["demo"]);
    expect(result.lockEntryRemoved).toBe(true);
    expect(result.fileRemoved).toBe(false);

    const s = await stat(jarPath);
    expect(s.isFile()).toBe(true);
  });

  test("without --keep-file: never deletes the user's own source jar", async () => {
    // Regression guard: cache key is content-addressed under
    // `<cache>/dependencies/file/<hex>.jar`; never the project-local path.
    const jarPath = join(dir, "libs", "custom.jar");
    await mkdir(join(dir, "libs"), { recursive: true });
    await writeFile(jarPath, "fake jar bytes");

    await writeJson(join(dir, "project.json"), {
      name: "demo",
      version: "1.0.0",
      main: "com.example.Main",
      compatibility: { versions: ["1.21.8"], platforms: ["paper"] },
      dependencies: {
        custom: { source: "file:./libs/custom.jar", version: "1.0.0" },
      },
    });
    await writeJson(join(dir, "pluggy.lock"), {
      version: 2,
      entries: {
        custom: {
          source: { kind: "file", path: jarPath, version: "1.0.0" },
          resolvedVersion: "1.0.0",
          integrity: "sha256-deadbeef",
          declaredBy: ["demo"],
        },
      },
    });

    await doRemove({ cwd: dir, plugin: "custom" });

    const s = await stat(jarPath);
    expect(s.isFile()).toBe(true);
  });

  test("errors when the dep is not declared (standalone)", async () => {
    await writeJson(join(dir, "project.json"), {
      name: "demo",
      version: "1.0.0",
      main: "com.example.Main",
      compatibility: { versions: ["1.21.8"], platforms: ["paper"] },
      dependencies: {},
    });

    await expect(doRemove({ cwd: dir, plugin: "ghost" })).rejects.toThrow(/"ghost"/);
  });

  test("--workspaces tolerates workspaces that don't declare the dep", async () => {
    await mkdir(join(dir, "a"), { recursive: true });
    await mkdir(join(dir, "b"), { recursive: true });
    await writeJson(join(dir, "project.json"), {
      name: "suite",
      version: "1.0.0",
      compatibility: { versions: ["1.21.8"], platforms: ["paper"] },
      workspaces: ["./a", "./b"],
    });
    await writeJson(join(dir, "a", "project.json"), {
      name: "ws-a",
      version: "0.1.0",
      main: "com.example.a.Plugin",
      dependencies: { worldedit: "7.3.15" },
    });
    await writeJson(join(dir, "b", "project.json"), {
      name: "ws-b",
      version: "0.1.0",
      main: "com.example.b.Plugin",
      dependencies: {},
    });

    const result = await doRemove({ cwd: dir, plugin: "worldedit", workspaces: true });
    expect(result.removed).toEqual(["ws-a"]);
    expect(result.missing).toEqual(["ws-b"]);
  });
});
