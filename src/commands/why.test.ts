import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";

import { initLogging } from "../logging.ts";

import { doWhy } from "./why.ts";

describe("doWhy", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "pluggy-why-"));
    initLogging({ json: true });
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
    initLogging({ json: false });
  });

  async function writeProject(): Promise<void> {
    await writeFile(
      join(rootDir, "project.json"),
      JSON.stringify({
        name: "my-plugin",
        version: "1.0.0",
        compatibility: { versions: ["1.21.8"], platforms: ["paper"] },
      }),
    );
  }

  async function writeLockfile(entries: Record<string, unknown>): Promise<void> {
    await writeFile(
      join(rootDir, "pluggy.lock"),
      `${JSON.stringify({ version: 2, entries }, null, 2)}\n`,
    );
  }

  test("traces a transitive to its declaring top-level", async () => {
    await writeProject();
    await writeLockfile({
      "paper-api": {
        source: {
          kind: "maven",
          groupId: "io.papermc.paper",
          artifactId: "paper-api",
          version: "1.21.8",
        },
        resolvedVersion: "1.21.8",
        integrity: "sha256-paper",
        declaredBy: ["my-plugin"],
        transitives: ["adventure-api"],
      },
      "adventure-api": {
        source: {
          kind: "maven",
          groupId: "net.kyori",
          artifactId: "adventure-api",
          version: "4.14.0",
        },
        resolvedVersion: "4.14.0",
        integrity: "sha256-adv",
        declaredBy: [],
        transitives: ["examination-api"],
      },
      "examination-api": {
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
    });

    const result = await doWhy({ name: "examination-api", cwd: rootDir });

    expect(result.name).toBe("examination-api");
    expect(result.paths).toHaveLength(1);
    expect(result.paths[0].chain).toEqual(["examination-api", "adventure-api", "paper-api"]);
    expect(result.paths[0].declaredBy).toEqual(["my-plugin"]);
  });

  test("returns the entry's own declaredBy when name is itself top-level", async () => {
    await writeProject();
    await writeLockfile({
      worldedit: {
        source: { kind: "modrinth", slug: "worldedit", version: "7.3.15" },
        resolvedVersion: "7.3.15",
        integrity: "sha256-we",
        declaredBy: ["my-plugin"],
      },
    });

    const result = await doWhy({ name: "worldedit", cwd: rootDir });

    expect(result.paths).toHaveLength(1);
    expect(result.paths[0].chain).toEqual(["worldedit"]);
    expect(result.paths[0].declaredBy).toEqual(["my-plugin"]);
  });

  test("reports every distinct path when a dep has multiple parents", async () => {
    await writeProject();
    await writeLockfile({
      "top-a": {
        source: { kind: "modrinth", slug: "top-a", version: "1.0.0" },
        resolvedVersion: "1.0.0",
        integrity: "sha256-a",
        declaredBy: ["my-plugin"],
        transitives: ["shared"],
      },
      "top-b": {
        source: { kind: "modrinth", slug: "top-b", version: "1.0.0" },
        resolvedVersion: "1.0.0",
        integrity: "sha256-b",
        declaredBy: ["my-plugin"],
        transitives: ["shared"],
      },
      shared: {
        source: { kind: "modrinth", slug: "shared", version: "1.0.0" },
        resolvedVersion: "1.0.0",
        integrity: "sha256-s",
        declaredBy: [],
      },
    });

    const result = await doWhy({ name: "shared", cwd: rootDir });

    expect(result.paths).toHaveLength(2);
    const heads = result.paths.map((p) => p.chain[p.chain.length - 1]).sort();
    expect(heads).toEqual(["top-a", "top-b"]);
  });

  test("throws E_WHY_NOT_FOUND for a name not in the lockfile", async () => {
    await writeProject();
    await writeLockfile({});
    await expect(doWhy({ name: "nope", cwd: rootDir })).rejects.toThrow(/no lockfile entry/i);
  });

  test("throws E_WHY_NO_LOCKFILE when pluggy.lock is missing", async () => {
    await writeProject();
    await expect(doWhy({ name: "anything", cwd: rootDir })).rejects.toThrow(/no pluggy\.lock/i);
  });
});
