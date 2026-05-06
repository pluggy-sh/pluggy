/** Tests for src/build/ide.ts. */

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";

import type { ResolvedProject } from "../project.ts";

import { writeIdeFiles } from "./ide.ts";

function makeProject(rootDir: string): ResolvedProject {
  return {
    name: "testplugin",
    version: "1.2.3",
    description: "A test plugin",
    main: "com.example.test.Main",
    compatibility: { versions: ["1.21.8"], platforms: ["paper"] },
    rootDir,
    projectFile: join(rootDir, "project.json"),
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe("writeIdeFiles", () => {
  let projectDir: string;
  let stagingDir: string;
  const classpath = [
    "/cache/maven/org.example/foo-bar/1.0.0.jar",
    "/cache/maven/com.acme/widget/2.5.jar",
  ];

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), "pluggy-ide-proj-"));
    stagingDir = await mkdtemp(join(tmpdir(), "pluggy-ide-stage-"));
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
    await rm(stagingDir, { recursive: true, force: true });
  });

  test("writes .classpath and .project at the project root", async () => {
    await writeIdeFiles(makeProject(projectDir), classpath, stagingDir);

    const classpathXml = await readFile(join(projectDir, ".classpath"), "utf8");
    expect(classpathXml).toContain('<classpathentry kind="src" path="src"/>');
    expect(classpathXml).toContain(
      '<classpathentry kind="con" path="org.eclipse.jdt.launching.JRE_CONTAINER"/>',
    );
    expect(classpathXml).toContain("/cache/maven/org.example/foo-bar/1.0.0.jar");
    expect(classpathXml).toContain("/cache/maven/com.acme/widget/2.5.jar");

    const projectXml = await readFile(join(projectDir, ".project"), "utf8");
    expect(projectXml).toContain("<name>testplugin</name>");
    expect(projectXml).toContain("org.eclipse.jdt.core.javabuilder");
    expect(projectXml).toContain("org.eclipse.jdt.core.javanature");
  });

  test("never touches .vscode/ even when it exists", async () => {
    const vscodeDir = join(projectDir, ".vscode");
    await mkdir(vscodeDir);
    const userSettings = '{\n  "editor.tabSize": 2\n}';
    await writeFile(join(vscodeDir, "settings.json"), userSettings);

    await writeIdeFiles(makeProject(projectDir), classpath, stagingDir);

    expect(await readFile(join(vscodeDir, "settings.json"), "utf8")).toBe(userSettings);
  });

  test("never touches .idea/ even when it exists", async () => {
    const ideaDir = join(projectDir, ".idea");
    await mkdir(ideaDir);
    const userIml =
      '<module classpath="eclipse" classpath-dir="$MODULE_DIR$" type="JAVA_MODULE" version="4"/>';
    await writeFile(join(ideaDir, "misc.xml"), "<user-misc/>");
    await writeFile(join(projectDir, "testplugin.iml"), userIml);

    await writeIdeFiles(makeProject(projectDir), classpath, stagingDir);

    // No new files inside .idea/.
    expect(await exists(join(ideaDir, "libraries"))).toBe(false);
    expect(await exists(join(ideaDir, "modules.xml"))).toBe(false);
    expect(await exists(join(ideaDir, ".gitignore"))).toBe(false);
    // Existing user files left exactly as-is.
    expect(await readFile(join(ideaDir, "misc.xml"), "utf8")).toBe("<user-misc/>");
    expect(await readFile(join(projectDir, "testplugin.iml"), "utf8")).toBe(userIml);
  });

  test("escapes XML-unsafe characters in jar paths", async () => {
    const tricky = ["/cache/with & ampersand/lib<x>.jar"];
    await writeIdeFiles(makeProject(projectDir), tricky, stagingDir);

    const classpathXml = await readFile(join(projectDir, ".classpath"), "utf8");
    expect(classpathXml).toContain("with &amp; ampersand/lib&lt;x&gt;.jar");
  });
});
