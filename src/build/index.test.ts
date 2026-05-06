/**
 * Tests for src/build/index.ts. Mocks resolver and javac; verifies the
 * pipeline fires stages in order with the right inputs.
 */

import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import type { ResolvedDependency } from "../resolver/index.ts";
import type { ResolvedProject } from "../project.ts";

vi.mock("../resolver/index.ts", () => ({
  resolveDependency: vi.fn(),
}));
vi.mock("../resolver/maven.ts", () => ({
  resolveMaven: vi.fn(),
}));
vi.mock("../sdk/index.ts", () => ({
  // Pipeline tests don't need a real JDK — they mock spawn entirely. Return
  // PATH-style placeholders so `compileJava` falls through to its `"javac"`
  // default and assertions like `expect(cmd).toBe("javac")` keep working.
  ensureJdkForProject: vi.fn(async () => ({
    javaPath: "java",
    javacPath: "javac",
    javaHome: "/fake",
    major: 21,
    source: "system" as const,
    distribution: "system",
    selection: { major: 21, distribution: "temurin", source: "fallback-default" as const },
  })),
}));
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, spawn: vi.fn() };
});

import { spawn } from "node:child_process";

import { resolveDependency } from "../resolver/index.ts";
import { resolveMaven } from "../resolver/maven.ts";

import { buildProject } from "./index.ts";

function makeProject(rootDir: string, overrides: Partial<ResolvedProject> = {}): ResolvedProject {
  return {
    name: "testplugin",
    version: "1.0.0",
    description: "A test plugin",
    main: "com.example.Main",
    compatibility: { versions: ["1.21.8"], platforms: ["paper"] },
    rootDir,
    projectFile: join(rootDir, "project.json"),
    ...overrides,
  };
}

function fakeDep(slug: string, jarPath: string): ResolvedDependency {
  return {
    source: { kind: "modrinth", slug, version: "1.0.0" },
    jarPath,
    integrity: "sha256-xxx",
    transitiveDeps: [],
  };
}

function fakeMavenDep(artifactId: string, jarPath: string): ResolvedDependency {
  return {
    source: { kind: "maven", groupId: "io.papermc.paper", artifactId, version: "1.21.8-R0.1" },
    jarPath,
    integrity: "sha256-yyy",
    transitiveDeps: [],
  };
}

function makeFakeChild(): {
  child: EventEmitter & { stdout: Readable; stderr: Readable };
  close: (code: number) => void;
} {
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  const ee = new EventEmitter() as EventEmitter & { stdout: Readable; stderr: Readable };
  ee.stdout = stdout;
  ee.stderr = stderr;
  return {
    child: ee,
    close: (code) => setImmediate(() => ee.emit("close", code)),
  };
}

describe("buildProject", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "pluggy-build-"));
    vi.mocked(resolveDependency).mockReset();
    vi.mocked(resolveMaven).mockReset();
    vi.mocked(spawn).mockReset();
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  test("drives the pipeline: resolve deps, stage resources, compile, shade, zip", async () => {
    await mkdir(join(workDir, "src", "com", "example"), { recursive: true });
    await writeFile(
      join(workDir, "src", "com", "example", "Main.java"),
      "package com.example; class Main {}",
    );

    // Jars must exist on disk for the zip/shade stages.
    const depJar = join(workDir, "fake-dep.jar");
    await writeFile(depJar, "FAKE JAR BYTES");
    const apiJar = join(workDir, "fake-api.jar");
    await writeFile(apiJar, "FAKE API BYTES");

    vi.mocked(resolveDependency).mockResolvedValueOnce(fakeDep("worldedit", depJar));
    vi.mocked(resolveMaven).mockResolvedValueOnce(fakeMavenDep("paper-api", apiJar));

    // Write a fake class file from the mocked javac so the zip step has content.
    vi.mocked(spawn).mockImplementation((_cmd: unknown, _args: unknown, _opts: unknown) => {
      const handle = makeFakeChild();
      const args = _args as string[];
      const dIdx = args.indexOf("-d");
      if (dIdx !== -1) {
        const outDir = args[dIdx + 1];
        void (async () => {
          await mkdir(outDir, { recursive: true });
          await writeFile(join(outDir, "Compiled.class"), "CLASS BYTES");
          handle.close(0);
        })();
      } else {
        handle.close(0);
      }
      return handle.child as unknown as ReturnType<typeof spawn>;
    });

    const project = makeProject(workDir, {
      dependencies: { worldedit: "7.3.15" },
      registries: ["https://repo.maven.org/maven2/"],
    });

    const result = await buildProject(project, {});

    expect(result.outputPath).toBe(join(workDir, "bin", "testplugin-1.0.0.jar"));
    expect(result.sizeBytes).toBeGreaterThan(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    await stat(result.outputPath);

    expect(spawn).toHaveBeenCalledTimes(1);
    const argv = vi.mocked(spawn).mock.calls[0][1] as string[];
    const cpIdx = argv.indexOf("-cp");
    expect(cpIdx).toBeGreaterThanOrEqual(0);
    const cp = argv[cpIdx + 1];
    expect(cp).toContain(depJar);
    expect(cp).toContain(apiJar);

    expect(resolveDependency).toHaveBeenCalledTimes(1);
    const [dispatchedSource, ctxArg] = vi.mocked(resolveDependency).mock.calls[0];
    expect(dispatchedSource).toEqual({ kind: "modrinth", slug: "worldedit", version: "7.3.15" });
    expect(ctxArg.registries).toContain("https://repo.maven.org/maven2/");

    expect(resolveMaven).toHaveBeenCalledTimes(1);
    const [groupId, artifactId] = vi.mocked(resolveMaven).mock.calls[0];
    expect(groupId).toBe("io.papermc.paper");
    expect(artifactId).toBe("paper-api");
  });

  test("respects --output override", async () => {
    await mkdir(join(workDir, "src"), { recursive: true });
    await writeFile(join(workDir, "src", "A.java"), "class A {}");

    vi.mocked(resolveMaven).mockResolvedValue(fakeMavenDep("paper-api", join(workDir, "a.jar")));
    await writeFile(join(workDir, "a.jar"), "X");

    vi.mocked(spawn).mockImplementation((_cmd: unknown, _args: unknown) => {
      const h = makeFakeChild();
      const args = _args as string[];
      const dIdx = args.indexOf("-d");
      void (async () => {
        if (dIdx !== -1) {
          await mkdir(args[dIdx + 1], { recursive: true });
          await writeFile(join(args[dIdx + 1], "A.class"), "ok");
        }
        h.close(0);
      })();
      return h.child as unknown as ReturnType<typeof spawn>;
    });

    const project = makeProject(workDir);
    const customOut = join(workDir, "custom", "my-plugin.jar");
    const result = await buildProject(project, { output: customOut });

    expect(result.outputPath).toBe(customOut);
    await stat(customOut);
  });

  test("fails fast on cross-family compatibility.platforms", async () => {
    await mkdir(join(workDir, "src"), { recursive: true });
    const project = makeProject(workDir, {
      compatibility: { versions: ["1.21.8"], platforms: ["paper", "velocity"] },
    });

    await expect(buildProject(project, {})).rejects.toThrow(/different descriptor families/);
  });

  test("user-supplied descriptor in `resources` wins over auto-generation", async () => {
    await mkdir(join(workDir, "src"), { recursive: true });
    await writeFile(join(workDir, "src", "A.java"), "class A {}");
    await mkdir(join(workDir, "res"), { recursive: true });
    await writeFile(join(workDir, "res", "plugin.yml"), "# user-supplied\nname: ${project.name}\n");

    vi.mocked(resolveMaven).mockResolvedValue(fakeMavenDep("paper-api", join(workDir, "a.jar")));
    await writeFile(join(workDir, "a.jar"), "X");

    let capturedOutDir: string | undefined;
    vi.mocked(spawn).mockImplementation((_cmd: unknown, _args: unknown) => {
      const h = makeFakeChild();
      const args = _args as string[];
      const dIdx = args.indexOf("-d");
      if (dIdx !== -1) capturedOutDir = args[dIdx + 1];
      void (async () => {
        if (capturedOutDir !== undefined) {
          await mkdir(capturedOutDir, { recursive: true });
          await writeFile(join(capturedOutDir, "A.class"), "ok");
        }
        h.close(0);
      })();
      return h.child as unknown as ReturnType<typeof spawn>;
    });

    const project = makeProject(workDir, {
      resources: { "plugin.yml": "./res/plugin.yml" },
    });
    await buildProject(project, {});

    const stagedYml = await readFile(join(capturedOutDir ?? "/nope", "plugin.yml"), "utf8");
    expect(stagedYml).toContain("# user-supplied");
    expect(stagedYml).toContain("name: testplugin");
  });
});
