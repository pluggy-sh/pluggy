/** Contract tests for `pluggy explain`. */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";

import { initLogging } from "../logging.ts";
import { runExplainCommand } from "./explain.ts";

describe("runExplainCommand", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "pluggy-explain-"));
    initLogging({ json: false, verbose: false, noColor: true });
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  test("standalone project: everything tagged as 'declared'", async () => {
    await writeFile(
      join(rootDir, "project.json"),
      JSON.stringify({
        name: "solo",
        version: "1.0.0",
        main: "com.example.M",
        compatibility: { versions: ["1.21"], platforms: ["paper"] },
      }),
    );

    const res = await runExplainCommand({ cwd: rootDir });
    expect(res.name).toBe("solo");
    expect(res.origins.name).toBe("declared");
    expect(res.origins.compatibility).toBe("declared");
    expect(res.origins.dependencies).toBe("absent");
  });

  test("workspace: tags inherited vs declared fields correctly", async () => {
    await mkdir(join(rootDir, "api"), { recursive: true });
    await writeFile(
      join(rootDir, "project.json"),
      JSON.stringify({
        name: "suite",
        version: "1.0.0",
        compatibility: { versions: ["1.21"], platforms: ["paper"] },
        dependencies: { "paper-api": "1.21" },
        jdk: { major: 21 },
        workspaces: ["./api"],
      }),
    );
    await writeFile(
      join(rootDir, "api", "project.json"),
      JSON.stringify({
        name: "api",
        version: "0.1.0",
        dependencies: { caffeine: "3.1.8" },
      }),
    );

    const res = await runExplainCommand({ cwd: rootDir, name: "api" });
    expect(res.origins.name).toBe("declared");
    expect(res.origins.compatibility).toBe("inherited");
    expect(res.origins.jdk).toBe("inherited");
    expect(res.origins.dependencies).toBe("merged");
    expect((res.project.dependencies as Record<string, unknown>)["paper-api"]).toBe("1.21");
    expect((res.project.dependencies as Record<string, unknown>)["caffeine"]).toBe("3.1.8");
  });

  test("defaults to current workspace when called from inside one", async () => {
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

    const res = await runExplainCommand({ cwd: join(rootDir, "api") });
    expect(res.name).toBe("api");
  });

  test("at root with workspaces and no --name: errors helpfully", async () => {
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

    await expect(runExplainCommand({ cwd: rootDir })).rejects.toThrow(/pass a workspace name/);
  });

  test("throws when not inside any pluggy project", async () => {
    await expect(runExplainCommand({ cwd: rootDir })).rejects.toThrow(/no pluggy project/i);
  });
});
