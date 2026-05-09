/** Tests for src/build/descriptor.ts. */

import { describe, expect, test } from "vite-plus/test";

import { createPlatform } from "../platform/platform.ts";
import type { ResolvedProject } from "../project.ts";

import { pickDescriptor } from "./descriptor.ts";

// Synthetic platforms for cross-family tests. The registry is module-level;
// ids only need to be unique.
createPlatform(() => ({
  id: "test-bukkit-a",
  descriptor: {
    path: "plugin.yml",
    format: "yaml" as const,
    family: "bukkit" as const,
    generate: () => "name: test\n",
  },
  versions: () => Promise.resolve([]),
  latest: () => Promise.resolve({ version: "1.0.0", build: 0 }),
  info: () => Promise.resolve({ version: "1.0.0", build: 0 }),
  download: () => Promise.reject(new Error("not used")),
  api: () => Promise.resolve({ repositories: [], dependencies: [] }),
  runtime: { pluginsDir: "plugins", serverArgs: [], vanillaServerFiles: false },
}));

createPlatform(() => ({
  id: "test-bukkit-b",
  descriptor: {
    path: "plugin.yml",
    format: "yaml" as const,
    family: "bukkit" as const,
    generate: () => "name: test\n",
  },
  versions: () => Promise.resolve([]),
  latest: () => Promise.resolve({ version: "1.0.0", build: 0 }),
  info: () => Promise.resolve({ version: "1.0.0", build: 0 }),
  download: () => Promise.reject(new Error("not used")),
  api: () => Promise.resolve({ repositories: [], dependencies: [] }),
  runtime: { pluginsDir: "plugins", serverArgs: [], vanillaServerFiles: false },
}));

createPlatform(() => ({
  id: "test-velocity",
  descriptor: {
    path: "velocity-plugin.json",
    format: "json" as const,
    family: "velocity" as const,
    generate: () => "{}\n",
  },
  versions: () => Promise.resolve([]),
  latest: () => Promise.resolve({ version: "1.0.0", build: 0 }),
  info: () => Promise.resolve({ version: "1.0.0", build: 0 }),
  download: () => Promise.reject(new Error("not used")),
  api: () => Promise.resolve({ repositories: [], dependencies: [] }),
  runtime: { pluginsDir: "plugins", serverArgs: [], vanillaServerFiles: false },
}));

function makeProject(platforms: string[]): ResolvedProject {
  return {
    name: "test-plugin",
    version: "1.0.0",
    main: "com.example.Main",
    compatibility: { versions: ["1.21.8"], platforms },
    rootDir: "/tmp/fake",
    projectFile: "/tmp/fake/project.json",
  };
}

describe("pickDescriptor", () => {
  test("returns the primary platform's descriptor", () => {
    const project = makeProject(["test-bukkit-a"]);
    const descriptor = pickDescriptor(project);
    expect(descriptor.path).toBe("plugin.yml");
  });

  test("accepts multiple platforms from the same descriptor family", () => {
    const project = makeProject(["test-bukkit-a", "test-bukkit-b"]);
    const descriptor = pickDescriptor(project);
    expect(descriptor.path).toBe("plugin.yml");
  });

  test("rejects cross-family compatibility arrays with a guidance error", () => {
    const project = makeProject(["test-bukkit-a", "test-velocity"]);
    expect(() => pickDescriptor(project)).toThrow(/different descriptor families/);
    expect(() => pickDescriptor(project)).toThrow(/workspaces/);
  });

  test("throws when compatibility.platforms is empty", () => {
    const project = makeProject([]);
    expect(() => pickDescriptor(project)).toThrow(/no compatibility\.platforms declared/);
  });

  test("throws when the primary platform is unknown", () => {
    const project = makeProject(["not-a-real-platform-id-xyz"]);
    expect(() => pickDescriptor(project)).toThrow(/unknown primary platform/);
  });

  test("throws when a secondary platform is unknown", () => {
    const project = makeProject(["test-bukkit-a", "also-fake-xyz"]);
    expect(() => pickDescriptor(project)).toThrow(/unknown platform.*also-fake-xyz/);
  });

  test("picks the real registered 'paper' platform", () => {
    const project = makeProject(["paper"]);
    const descriptor = pickDescriptor(project);
    expect(descriptor.path).toBe("plugin.yml");
  });
});
