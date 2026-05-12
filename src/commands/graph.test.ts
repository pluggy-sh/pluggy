/** Contract tests for `pluggy graph`. */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";

import { initLogging } from "../logging.ts";
import { runGraphCommand } from "./graph.ts";

describe("runGraphCommand", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "pluggy-graph-"));
    initLogging({ json: false, verbose: false, noColor: true });
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
  }

  test("nodes listed in topological order", async () => {
    await writeTrio();
    const res = await runGraphCommand({ cwd: rootDir });
    expect(res.nodes).toEqual(["api", "core", "plugin"]);
  });

  test("edges record every workspace:<name> dep", async () => {
    await writeTrio();
    const res = await runGraphCommand({ cwd: rootDir });
    expect(res.edges).toContainEqual({ from: "core", to: "api" });
    expect(res.edges).toContainEqual({ from: "plugin", to: "api" });
    expect(res.edges).toContainEqual({ from: "plugin", to: "core" });
  });

  test("standalone project: empty nodes/edges, exit 0", async () => {
    await writeFile(
      join(rootDir, "project.json"),
      JSON.stringify({
        name: "solo",
        version: "1.0.0",
        main: "com.example.M",
        compatibility: { versions: ["1.21"], platforms: ["paper"] },
      }),
    );
    const res = await runGraphCommand({ cwd: rootDir });
    expect(res.nodes).toEqual([]);
    expect(res.edges).toEqual([]);
  });

  test("--mermaid emits a Mermaid graph TD definition", async () => {
    await writeTrio();
    const res = await runGraphCommand({ cwd: rootDir, mermaid: true });
    expect(res.mermaid).toBeDefined();
    expect(res.mermaid).toContain("graph TD");
    expect(res.mermaid).toContain('api["api"]');
    expect(res.mermaid).toContain("plugin --> api");
    expect(res.mermaid).toContain("plugin --> core");
  });

  test("throws when not inside any pluggy project", async () => {
    await expect(runGraphCommand({ cwd: rootDir })).rejects.toThrow(/no pluggy project/i);
  });
});
