import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";

import "../platform/index.ts";
import type { Project } from "../project.ts";

import { generateProject } from "./init.ts";

describe("generateProject: embedded family stubs", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pluggy-init-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("velocity-only project gets a Velocity stub (not Bukkit JavaPlugin)", async () => {
    const project: Project = {
      name: "myproxy",
      version: "1.0.0",
      description: "x",
      main: "com.example.MyProxy",
      compatibility: { versions: ["1.21.8"], platforms: ["velocity"] },
    };
    await generateProject(dir, project);

    const main = await readFile(join(dir, "src", "com", "example", "MyProxy.java"), "utf8");
    expect(main).toContain("@Plugin(");
    expect(main).toContain("com.velocitypowered.api.plugin.Plugin");
    expect(main).not.toContain("org.bukkit.plugin.java.JavaPlugin");
  });

  test("waterfall (bungee family) gets a Bungee Plugin stub", async () => {
    const project: Project = {
      name: "myproxy",
      version: "1.0.0",
      description: "x",
      main: "com.example.MyProxy",
      compatibility: { versions: ["1.21.8"], platforms: ["waterfall"] },
    };
    await generateProject(dir, project);

    const main = await readFile(join(dir, "src", "com", "example", "MyProxy.java"), "utf8");
    expect(main).toContain("net.md_5.bungee.api.plugin.Plugin");
    expect(main).toContain("extends Plugin");
    expect(main).not.toContain("org.bukkit.plugin.java.JavaPlugin");
  });

  test("paper project gets the Bukkit JavaPlugin stub", async () => {
    const project: Project = {
      name: "myplugin",
      version: "1.0.0",
      description: "x",
      main: "com.example.MyPlugin",
      compatibility: { versions: ["1.21.8"], platforms: ["paper"] },
    };
    await generateProject(dir, project);

    const main = await readFile(join(dir, "src", "com", "example", "MyPlugin.java"), "utf8");
    expect(main).toContain("org.bukkit.plugin.java.JavaPlugin");
    expect(main).toContain("extends JavaPlugin");
  });
});

describe("generateProject: template files", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pluggy-init-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("templateFiles replace the embedded stub at the listed paths", async () => {
    const project: Project = {
      name: "myplugin",
      version: "1.0.0",
      description: "x",
      main: "com.example.MyPlugin",
      compatibility: { versions: ["1.21.8"], platforms: ["paper"] },
    };

    await generateProject(dir, project, {
      templateFiles: [
        { path: "src/com/example/MyPlugin.java", content: "// from template\n" },
        { path: "src/config.yml", content: "from: template\n" },
        { path: "test/com/example/MyPluginTest.java", content: "// test from template\n" },
      ],
    });

    const main = await readFile(join(dir, "src", "com", "example", "MyPlugin.java"), "utf8");
    expect(main).toBe("// from template\n");
    const cfg = await readFile(join(dir, "src", "config.yml"), "utf8");
    expect(cfg).toBe("from: template\n");
    const testFile = await readFile(
      join(dir, "test", "com", "example", "MyPluginTest.java"),
      "utf8",
    );
    expect(testFile).toBe("// test from template\n");
  });

  test("rejects template files that escape distDir (zip-slip)", async () => {
    const project: Project = {
      name: "myplugin",
      version: "1.0.0",
      description: "x",
      main: "com.example.MyPlugin",
      compatibility: { versions: ["1.21.8"], platforms: ["paper"] },
    };

    await expect(
      generateProject(dir, project, {
        templateFiles: [{ path: "../escape.txt", content: "evil" }],
      }),
    ).rejects.toThrow(/Refusing to write/);

    await expect(
      generateProject(dir, project, {
        templateFiles: [{ path: "files/../../etc/evil", content: "evil" }],
      }),
    ).rejects.toThrow(/Refusing to write/);
  });
});
