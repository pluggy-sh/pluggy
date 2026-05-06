import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";

import { listTemplates, loadTemplate } from "./index.ts";

describe("templates (local source)", () => {
  let dir: string;
  let prevEnv: string | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pluggy-templates-"));
    prevEnv = process.env.PLUGGY_TEMPLATE_DIR;
    process.env.PLUGGY_TEMPLATE_DIR = dir;
  });

  afterEach(async () => {
    if (prevEnv === undefined) delete process.env.PLUGGY_TEMPLATE_DIR;
    else process.env.PLUGGY_TEMPLATE_DIR = prevEnv;
    await rm(dir, { recursive: true, force: true });
  });

  test("listTemplates reads templates/index.json from PLUGGY_TEMPLATE_DIR", async () => {
    await writeFile(
      join(dir, "index.json"),
      JSON.stringify({
        templates: [{ id: "demo", name: "Demo", description: "x", family: "bukkit" }],
      }),
    );

    const list = await listTemplates();
    expect(list).toEqual([{ id: "demo", name: "Demo", description: "x", family: "bukkit" }]);
  });

  test("loadTemplate substitutes filename and content placeholders", async () => {
    const root = join(dir, "demo");
    await mkdir(join(root, "files", "src", "__packagePath__"), { recursive: true });
    await writeFile(
      join(root, "template.json"),
      JSON.stringify({
        id: "demo",
        name: "Demo",
        description: "x",
        family: "bukkit",
      }),
    );
    await writeFile(
      join(root, "files", "src", "__packagePath__", "__className__.java"),
      "package ${project.packageName};\n// class: ${project.className}\n",
    );

    const result = await loadTemplate("demo", {
      className: "MyPlugin",
      packagePath: "com/example",
      replacements: {
        project: { packageName: "com.example", className: "MyPlugin" },
      },
    });

    expect(result.metadata.id).toBe("demo");
    expect(result.files).toHaveLength(1);
    expect(result.files[0].path).toBe("src/com/example/MyPlugin.java");
    expect(result.files[0].content).toContain("package com.example;");
    expect(result.files[0].content).toContain("// class: MyPlugin");
  });

  test("loadTemplate runs ${...} substitution over projectJsonExtras", async () => {
    const root = join(dir, "withextras");
    await mkdir(join(root, "files"), { recursive: true });
    await writeFile(
      join(root, "template.json"),
      JSON.stringify({
        id: "withextras",
        name: "x",
        description: "x",
        family: "bukkit",
        projectJsonExtras: {
          testDependencies: {
            mockbukkit: {
              source: "maven:org.mockbukkit.mockbukkit:mockbukkit-v${project.apiVersion}",
              version: "4.90.0",
            },
          },
        },
      }),
    );

    const result = await loadTemplate("withextras", {
      className: "X",
      packagePath: "com/x",
      replacements: { project: { apiVersion: "1.21" } },
    });

    expect(result.metadata.projectJsonExtras).toEqual({
      testDependencies: {
        mockbukkit: {
          source: "maven:org.mockbukkit.mockbukkit:mockbukkit-v1.21",
          version: "4.90.0",
        },
      },
    });
  });

  test("loadTemplate throws when the id is unknown", async () => {
    await expect(
      loadTemplate("nope", {
        className: "X",
        packagePath: "com/x",
        replacements: {},
      }),
    ).rejects.toThrow(/not found/);
  });

  test("repo templates round-trip through the local fetcher", async () => {
    // Point at the real templates dir to verify each shipped template is
    // structurally valid: index.json lists it, template.json parses, every
    // file resolves through the substitution pipeline.
    const realDir = join(import.meta.dirname, "..", "..", "templates");
    process.env.PLUGGY_TEMPLATE_DIR = realDir;

    const list = await listTemplates();
    expect(list.length).toBeGreaterThan(0);

    for (const summary of list) {
      const result = await loadTemplate(summary.id, {
        className: "MyPlugin",
        packagePath: "com/example",
        replacements: {
          project: {
            name: "myplugin",
            version: "1.0.0",
            description: "x",
            main: "com.example.MyPlugin",
            className: "MyPlugin",
            packageName: "com.example",
            velocityId: "myplugin",
            apiVersion: "1.21",
            compatibility: { versions: ["1.21.8"], platforms: [summary.family] },
          },
        },
      });
      expect(result.metadata.id).toBe(summary.id);
      expect(result.metadata.family).toBe(summary.family);
      expect(result.files.length).toBeGreaterThan(0);
      // No raw placeholders should leak into materialised files.
      for (const f of result.files) {
        expect(f.path).not.toMatch(/__packagePath__|__className__/);
      }
    }
  });
});
