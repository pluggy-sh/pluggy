/** Contract tests for project.json read/write helpers. */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";

import {
  type Project,
  type ResolvedProject,
  resolveProjectFile,
  writeProjectFile,
} from "./project.ts";

describe("writeProjectFile", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "pluggy-project-"));
  });
  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  test("round-trips a Project through write then resolve", async () => {
    const path = join(workDir, "project.json");
    const project: Project = {
      name: "demo",
      version: "1.0.0",
      compatibility: { versions: ["1.21"], platforms: ["paper"] },
      dependencies: { "paper-api": "1.21-R0.1-SNAPSHOT" },
    };

    await writeProjectFile(path, project);

    const resolved = resolveProjectFile(path);
    expect(resolved).toBeDefined();
    expect(resolved?.name).toBe("demo");
    expect(resolved?.version).toBe("1.0.0");
    expect(resolved?.compatibility).toEqual({ versions: ["1.21"], platforms: ["paper"] });
    expect(resolved?.dependencies).toEqual({ "paper-api": "1.21-R0.1-SNAPSHOT" });
  });

  test("writes LF line endings and a trailing newline", async () => {
    const path = join(workDir, "project.json");
    const project: Project = {
      name: "demo",
      version: "1.0.0",
      compatibility: { versions: ["1.21"], platforms: ["paper"] },
    };

    await writeProjectFile(path, project);
    const raw = await readFile(path, "utf8");

    expect(raw.endsWith("\n")).toBe(true);
    expect(raw.includes("\r\n")).toBe(false);
  });

  test("two-space JSON indent", async () => {
    const path = join(workDir, "project.json");
    const project: Project = {
      name: "demo",
      version: "1.0.0",
      compatibility: { versions: ["1.21"], platforms: ["paper"] },
    };

    await writeProjectFile(path, project);
    const raw = await readFile(path, "utf8");

    expect(raw).toContain('  "name": "demo"');
  });

  test("strips ResolvedProject-only fields (rootDir, projectFile)", async () => {
    const path = join(workDir, "project.json");
    const resolved: ResolvedProject = {
      name: "demo",
      version: "1.0.0",
      compatibility: { versions: ["1.21"], platforms: ["paper"] },
      rootDir: "/should/not/persist",
      projectFile: "/should/not/persist/project.json",
    };

    await writeProjectFile(path, resolved);
    const raw = await readFile(path, "utf8");

    expect(raw.includes("rootDir")).toBe(false);
    expect(raw.includes("projectFile")).toBe(false);
  });

  test("preserves optional fields verbatim", async () => {
    const path = join(workDir, "project.json");
    const project: Project = {
      name: "demo",
      version: "1.0.0",
      description: "a demo plugin",
      authors: ["alice", "bob"],
      main: "com.example.Demo",
      compatibility: { versions: ["1.21"], platforms: ["paper"] },
      jdk: { major: 21, distribution: "temurin" },
    };

    await writeProjectFile(path, project);
    const resolved = resolveProjectFile(path);

    expect(resolved?.description).toBe("a demo plugin");
    expect(resolved?.authors).toEqual(["alice", "bob"]);
    expect(resolved?.main).toBe("com.example.Demo");
    expect(resolved?.jdk).toEqual({ major: 21, distribution: "temurin" });
  });
});
