/** Tests for src/build/intellij.ts. */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";

import type { Project } from "../project.ts";

import { jdkMajorForMcVersion, writeIntellijStub } from "./intellij.ts";

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    name: "demo",
    version: "1.0.0",
    description: "test",
    main: "com.example.Demo",
    compatibility: { versions: ["1.21.8"], platforms: ["paper"] },
    ...overrides,
  };
}

describe("jdkMajorForMcVersion", () => {
  test("maps Minecraft versions to required JDK majors", () => {
    expect(jdkMajorForMcVersion("1.21.8")).toBe(21);
    expect(jdkMajorForMcVersion("1.21")).toBe(21);
    expect(jdkMajorForMcVersion("1.20.5")).toBe(21);
    expect(jdkMajorForMcVersion("1.20.4")).toBe(17);
    expect(jdkMajorForMcVersion("1.18.0")).toBe(17);
    expect(jdkMajorForMcVersion("1.17.1")).toBe(16);
    expect(jdkMajorForMcVersion("1.16.5")).toBe(8);
    expect(jdkMajorForMcVersion("1.8.8")).toBe(8);
  });

  test("falls back to 21 for unparseable or missing versions", () => {
    expect(jdkMajorForMcVersion(undefined)).toBe(21);
    expect(jdkMajorForMcVersion("nonsense")).toBe(21);
    expect(jdkMajorForMcVersion("")).toBe(21);
  });
});

describe("writeIntellijStub", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pluggy-intellij-stub-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("writes the four expected files", async () => {
    await writeIntellijStub(dir, makeProject());

    const iml = await readFile(join(dir, "demo.iml"), "utf8");
    expect(iml).toContain('classpath="eclipse"');
    expect(iml).toContain('classpath-dir="$MODULE_DIR$"');
    expect(iml).toContain('type="JAVA_MODULE"');

    const modules = await readFile(join(dir, ".idea", "modules.xml"), "utf8");
    expect(modules).toContain('fileurl="file://$PROJECT_DIR$/demo.iml"');
    expect(modules).toContain('filepath="$PROJECT_DIR$/demo.iml"');

    const misc = await readFile(join(dir, ".idea", "misc.xml"), "utf8");
    expect(misc).toContain('languageLevel="JDK_21"');
    // No `project-jdk-name` — IntelliJ prompts the user to pick one once.
    expect(misc).not.toContain("project-jdk-name");

    const ignore = await readFile(join(dir, ".idea", ".gitignore"), "utf8");
    expect(ignore).toContain("workspace.xml");
    expect(ignore).toContain("shelf/");
  });

  test("language level reflects the project's primary Minecraft version", async () => {
    await writeIntellijStub(
      dir,
      makeProject({ compatibility: { versions: ["1.16.5"], platforms: ["paper"] } }),
    );
    const misc = await readFile(join(dir, ".idea", "misc.xml"), "utf8");
    expect(misc).toContain('languageLevel="JDK_8"');
  });

  test("uses the project name in the .iml filename and modules.xml entry", async () => {
    await writeIntellijStub(dir, makeProject({ name: "my-cool-plugin" }));

    const modules = await readFile(join(dir, ".idea", "modules.xml"), "utf8");
    expect(modules).toContain("my-cool-plugin.iml");
    // The .iml itself was written at the right location.
    await readFile(join(dir, "my-cool-plugin.iml"), "utf8");
  });
});
