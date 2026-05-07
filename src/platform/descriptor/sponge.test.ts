/**
 * Contract tests for the Sponge Plugin Metadata generator. Output is JSON,
 * so tests parse with `JSON.parse` and assert on shape.
 */

import { describe, expect, test } from "vite-plus/test";

import type { ResolvedProject } from "../../project.ts";

import { deriveSpongeId, spongeDescriptor } from "./sponge.ts";

function project(overrides: Partial<ResolvedProject> = {}): ResolvedProject {
  return {
    name: "myplugin",
    version: "1.0.0",
    main: "com.example.MyPlugin",
    compatibility: { versions: ["1.21.8"], platforms: ["sponge"] },
    rootDir: "/tmp/project",
    projectFile: "/tmp/project/project.json",
    ...overrides,
  };
}

describe("spongeDescriptor.generate", () => {
  test("emits required fields for a minimal project", () => {
    const output = spongeDescriptor.generate(project());
    const parsed = JSON.parse(output);

    expect(parsed.loader).toEqual({ name: "java_plain", version: "1.0" });
    expect(parsed.license).toBe("All Rights Reserved");
    expect(parsed.global).toEqual({ version: "1.0.0" });
    expect(parsed.plugins).toHaveLength(1);
    expect(parsed.plugins[0]).toMatchObject({
      id: "myplugin",
      name: "myplugin",
      entrypoint: "com.example.MyPlugin",
    });
    expect(parsed.plugins[0].description).toBeUndefined();
    expect(parsed.plugins[0].contributors).toBeUndefined();
    expect(output.endsWith("\n")).toBe(true);
  });

  test("emits description and contributors when present", () => {
    const output = spongeDescriptor.generate(
      project({ description: "A sponge plugin.", authors: ["Alice", "Bob"] }),
    );
    const parsed = JSON.parse(output);
    expect(parsed.plugins[0].description).toBe("A sponge plugin.");
    expect(parsed.plugins[0].contributors).toEqual([{ name: "Alice" }, { name: "Bob" }]);
  });

  test("throws when main is missing", () => {
    expect(() => spongeDescriptor.generate(project({ main: undefined }))).toThrow(
      "Sponge descriptor requires project.main",
    );
  });

  test("descriptor path is META-INF/sponge_plugins.json", () => {
    expect(spongeDescriptor.path).toBe("META-INF/sponge_plugins.json");
  });

  test("uses LF line endings only", () => {
    const output = spongeDescriptor.generate(project({ description: "x", authors: ["A"] }));
    expect(output.split("\r\n").length).toBe(1);
  });

  test("output is valid JSON", () => {
    const output = spongeDescriptor.generate(project({ authors: ["A"] }));
    expect(() => JSON.parse(output)).not.toThrow();
  });
});

describe("deriveSpongeId", () => {
  test("lowercases a plain name", () => {
    expect(deriveSpongeId("MyPlugin")).toBe("myplugin");
  });

  test("replaces disallowed characters with hyphens", () => {
    expect(deriveSpongeId("My Plugin!")).toBe("my-plugin-");
  });

  test("keeps hyphens and underscores as-is", () => {
    expect(deriveSpongeId("my_cool-plugin")).toBe("my_cool-plugin");
  });

  test("prefixes with 'p-' when the result starts with a digit", () => {
    expect(deriveSpongeId("1plugin")).toBe("p-1plugin");
  });

  test("truncates to 64 characters", () => {
    const long = "a".repeat(100);
    expect(deriveSpongeId(long).length).toBeLessThanOrEqual(64);
  });

  test("pads single-character names so id is at least 2 characters", () => {
    expect(deriveSpongeId("x").length).toBeGreaterThanOrEqual(2);
  });
});
