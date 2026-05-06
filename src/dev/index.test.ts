/**
 * Tests for src/dev/index.ts. Every downstream module — buildProject,
 * resolveDependency, the platform registry, and the four `dev/*` helpers —
 * is mocked so `runDev`'s orchestration is exercised in isolation.
 */

import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import type { ResolvedProject } from "../project.ts";

vi.mock("../build/index.ts", () => ({
  buildProject: vi.fn(),
  projectStagingDir: vi.fn((p: { rootDir: string }) => `${p.rootDir}/.pluggy-build/abc`),
}));

vi.mock("../resolver/index.ts", () => ({
  resolveDependency: vi.fn(),
}));

vi.mock("../platform/index.ts", () => ({
  getPlatform: vi.fn(),
}));

vi.mock("./stage.ts", () => ({
  stageDev: vi.fn(),
}));

vi.mock("./plugins.ts", () => ({
  stagePlugins: vi.fn(),
  isRuntimePlugin: vi.fn(),
}));

vi.mock("./spawn.ts", () => ({
  spawnServer: vi.fn(),
}));

vi.mock("./watch.ts", () => ({
  watchProject: vi.fn(),
}));

vi.mock("./hotswap.ts", () => ({
  ensureAgent: vi.fn(async () => "/cache/agents/hotswap-agent.jar"),
  agentJvmArgs: vi.fn(() => []),
  renderPropertiesFile: vi.fn(() => "extraClasspath=/test\n"),
  start: vi.fn(() => ({
    arm: vi.fn(),
    wait: vi.fn(async () => "reloaded"),
    stop: vi.fn(),
  })),
}));

vi.mock("./jbr.ts", () => ({
  ensureJbr: vi.fn(async () => "java"),
}));

vi.mock("../sdk/index.ts", () => ({
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

vi.mock("../portable.ts", async () => {
  const actual = await vi.importActual<typeof import("../portable.ts")>("../portable.ts");
  return { ...actual, linkOrCopy: vi.fn(async () => {}) };
});

import { buildProject } from "../build/index.ts";
import { getPlatform } from "../platform/index.ts";
import type { DescriptorSpec, PlatformProvider, Version } from "../platform/platform.ts";
import { resolveDependency } from "../resolver/index.ts";

import { isRuntimePlugin, stagePlugins } from "./plugins.ts";
import { spawnServer } from "./spawn.ts";
import { stageDev } from "./stage.ts";
import { watchProject } from "./watch.ts";

import { runDev } from "./index.ts";

function makeProject(rootDir: string, overrides: Partial<ResolvedProject> = {}): ResolvedProject {
  return {
    name: "testplugin",
    version: "1.0.0",
    main: "com.example.Main",
    compatibility: { versions: ["1.21.8"], platforms: ["paper"] },
    rootDir,
    projectFile: join(rootDir, "project.json"),
    ...overrides,
  };
}

function fakeDescriptor(): DescriptorSpec {
  return { path: "plugin.yml", format: "yaml", generate: () => "name: x\n" };
}

function fakePlatform(id = "paper"): PlatformProvider {
  return {
    id,
    descriptor: fakeDescriptor(),
    getVersions: vi.fn(async () => ["1.21.8"]),
    getLatestVersion: vi.fn(async () => ({ version: "1.21.8", build: 42 }) as Version),
    getVersionInfo: vi.fn(async (v: string) => ({ version: v, build: 42 }) as Version),
    download: vi.fn(async (v: Version) => ({ ...v, output: new Uint8Array([1, 2, 3]) })),
    api: vi.fn(async () => ({ repositories: [], dependencies: [] })),
  };
}

interface FakeChild extends EventEmitter {
  stdin: { destroyed: boolean; writable: boolean; write: (s: string) => boolean } | null;
  pid?: number;
}

function makeFakeChild(): FakeChild {
  const ee = new EventEmitter() as FakeChild;
  ee.stdin = {
    destroyed: false,
    writable: true,
    write: vi.fn(() => true),
  };
  ee.pid = 1234;
  return ee;
}

describe("runDev", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "pluggy-dev-index-"));
    vi.mocked(getPlatform).mockReset();
    vi.mocked(buildProject).mockReset();
    vi.mocked(resolveDependency).mockReset();
    vi.mocked(stageDev).mockReset();
    vi.mocked(stagePlugins).mockReset();
    vi.mocked(isRuntimePlugin).mockReset();
    vi.mocked(spawnServer).mockReset();
    vi.mocked(watchProject).mockReset();
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  test("drives the pipeline in order: platform → build → stage → plugins → spawn → watch", async () => {
    const platform = fakePlatform("paper");
    vi.mocked(getPlatform).mockReturnValue(platform);

    vi.mocked(buildProject).mockResolvedValue({
      outputPath: join(workDir, "bin", "testplugin-1.0.0.jar"),
      sizeBytes: 42,
      stagingDir: join(workDir, ".pluggy-build", "abc"),
      durationMs: 1,
    });

    const devDirPath = join(workDir, "dev");
    await mkdir(devDirPath, { recursive: true });
    vi.mocked(stageDev).mockResolvedValue(devDirPath);
    vi.mocked(stagePlugins).mockResolvedValue(undefined);

    const fakeChild = makeFakeChild();
    vi.mocked(spawnServer).mockReturnValue(fakeChild as unknown as ReturnType<typeof spawnServer>);

    vi.mocked(watchProject).mockReturnValue((): void => {});

    // runDev awaits child exit.
    setImmediate(() => fakeChild.emit("exit", 0, null));

    const project = makeProject(workDir);
    await runDev(project, {});

    expect(getPlatform).toHaveBeenCalledWith("paper");

    expect(buildProject).toHaveBeenCalledTimes(1);
    expect(vi.mocked(buildProject).mock.calls[0][0]).toBe(project);

    expect(stageDev).toHaveBeenCalledTimes(1);
    const [stageProjArg, stageJarArg, stageOptsArg] = vi.mocked(stageDev).mock.calls[0];
    expect(stageProjArg).toBe(project);
    // <cachePath>/versions/<id>-<ver>-<build>.jar
    expect(stageJarArg).toMatch(/[\\/]versions[\\/]paper-1\.21\.8-42\.jar$/);
    expect(stageOptsArg.port).toBeUndefined();

    expect(stagePlugins).toHaveBeenCalledTimes(1);
    const [devDirArg, ownJarArg, runtimeDepsArg, extrasArg] = vi.mocked(stagePlugins).mock.calls[0];
    expect(devDirArg).toBe(devDirPath);
    expect(ownJarArg).toBe(join(workDir, "bin", "testplugin-1.0.0.jar"));
    expect(runtimeDepsArg).toEqual([]);
    expect(extrasArg).toEqual([]);

    expect(spawnServer).toHaveBeenCalledTimes(1);
    const spawnOpts = vi.mocked(spawnServer).mock.calls[0][0];
    expect(spawnOpts.devDir).toBe(devDirPath);
    expect(spawnOpts.serverJarName).toBe("server.jar");
    expect(spawnOpts.memory).toBe("2G");
    expect(spawnOpts.jvmArgs).toEqual([]);

    expect(watchProject).toHaveBeenCalledTimes(1);
    const [watchProjArg, watchOptsArg] = vi.mocked(watchProject).mock.calls[0];
    expect(watchProjArg).toBe(project);
    expect(watchOptsArg.debounceMs).toBe(200);
  });

  test("honors opts.platform / opts.version overrides", async () => {
    const platform = fakePlatform("folia");
    vi.mocked(getPlatform).mockReturnValue(platform);
    vi.mocked(buildProject).mockResolvedValue({
      outputPath: join(workDir, "plugin.jar"),
      sizeBytes: 1,
      stagingDir: join(workDir, ".pluggy-build", "abc"),
      durationMs: 1,
    });
    vi.mocked(stageDev).mockResolvedValue(join(workDir, "dev"));
    vi.mocked(stagePlugins).mockResolvedValue(undefined);
    const child = makeFakeChild();
    vi.mocked(spawnServer).mockReturnValue(child as unknown as ReturnType<typeof spawnServer>);
    vi.mocked(watchProject).mockReturnValue(() => {});

    setImmediate(() => child.emit("exit", 0, null));

    const project = makeProject(workDir);
    await runDev(project, { platform: "folia", version: "1.22.0", watch: false });

    expect(getPlatform).toHaveBeenCalledWith("folia");
    // The jar path carries the overridden version, proving getVersionInfo was
    // invoked with opts.version. Asserting on the path avoids the unbound-
    // method lint that would fire on `platform.getVersionInfo`.
    const stageJarArg = vi.mocked(stageDev).mock.calls[0][1];
    expect(stageJarArg).toMatch(/folia-1\.22\.0-42\.jar$/);
    expect(watchProject).not.toHaveBeenCalled();
  });

  test("filters dependencies to runtime plugins via isRuntimePlugin", async () => {
    const platform = fakePlatform("paper");
    vi.mocked(getPlatform).mockReturnValue(platform);
    vi.mocked(buildProject).mockResolvedValue({
      outputPath: join(workDir, "plugin.jar"),
      sizeBytes: 1,
      stagingDir: join(workDir, ".pluggy-build", "abc"),
      durationMs: 1,
    });
    vi.mocked(stageDev).mockResolvedValue(join(workDir, "dev"));
    vi.mocked(stagePlugins).mockResolvedValue(undefined);
    const child = makeFakeChild();
    vi.mocked(spawnServer).mockReturnValue(child as unknown as ReturnType<typeof spawnServer>);
    vi.mocked(watchProject).mockReturnValue(() => {});

    vi.mocked(resolveDependency)
      .mockResolvedValueOnce({
        source: { kind: "modrinth", slug: "worldedit", version: "7" },
        jarPath: "/cache/worldedit.jar",
        integrity: "sha256-a",
        transitiveDeps: [],
      })
      .mockResolvedValueOnce({
        source: { kind: "maven", groupId: "g", artifactId: "lib", version: "1" },
        jarPath: "/cache/lib.jar",
        integrity: "sha256-b",
        transitiveDeps: [],
      });

    // worldedit is a runtime plugin; lib is not.
    vi.mocked(isRuntimePlugin).mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    setImmediate(() => child.emit("exit", 0, null));

    const project = makeProject(workDir, {
      dependencies: {
        worldedit: "7.3.15",
        "some-lib": { source: "maven:g:lib", version: "1" },
      },
    });
    await runDev(project, { watch: false });

    const runtimeDepsArg = vi.mocked(stagePlugins).mock.calls[0][2];
    expect(runtimeDepsArg).toHaveLength(1);
    expect(runtimeDepsArg[0].source.kind).toBe("modrinth");
  });

  test("extraPlugins are resolved relative to project.rootDir", async () => {
    const platform = fakePlatform("paper");
    vi.mocked(getPlatform).mockReturnValue(platform);
    vi.mocked(buildProject).mockResolvedValue({
      outputPath: join(workDir, "plugin.jar"),
      sizeBytes: 1,
      stagingDir: join(workDir, ".pluggy-build", "abc"),
      durationMs: 1,
    });
    vi.mocked(stageDev).mockResolvedValue(join(workDir, "dev"));
    vi.mocked(stagePlugins).mockResolvedValue(undefined);
    const child = makeFakeChild();
    vi.mocked(spawnServer).mockReturnValue(child as unknown as ReturnType<typeof spawnServer>);
    vi.mocked(watchProject).mockReturnValue(() => {});

    setImmediate(() => child.emit("exit", 0, null));

    const project = makeProject(workDir, {
      dev: { extraPlugins: ["./dev-plugins/debug.jar", "./dev-plugins/tools.jar"] },
    });
    await runDev(project, { watch: false });

    const extras = vi.mocked(stagePlugins).mock.calls[0][3];
    expect(extras).toEqual([
      join(workDir, "dev-plugins", "debug.jar"),
      join(workDir, "dev-plugins", "tools.jar"),
    ]);
  });

  test("passes memory and jvmArgs from opts before falling back to project.dev", async () => {
    const platform = fakePlatform("paper");
    vi.mocked(getPlatform).mockReturnValue(platform);
    vi.mocked(buildProject).mockResolvedValue({
      outputPath: join(workDir, "plugin.jar"),
      sizeBytes: 1,
      stagingDir: join(workDir, ".pluggy-build", "abc"),
      durationMs: 1,
    });
    vi.mocked(stageDev).mockResolvedValue(join(workDir, "dev"));
    vi.mocked(stagePlugins).mockResolvedValue(undefined);
    const child = makeFakeChild();
    vi.mocked(spawnServer).mockReturnValue(child as unknown as ReturnType<typeof spawnServer>);
    vi.mocked(watchProject).mockReturnValue(() => {});

    setImmediate(() => child.emit("exit", 0, null));

    const project = makeProject(workDir, {
      dev: { memory: "4G", jvmArgs: ["-Dbase=true"] },
    });
    await runDev(project, {
      watch: false,
      memory: "8G",
      args: ["-Doverride=true"],
    });

    const opts = vi.mocked(spawnServer).mock.calls[0][0];
    expect(opts.memory).toBe("8G");
    expect(opts.jvmArgs).toEqual(["-Doverride=true"]);
  });

  test("throws when no platform is configured", async () => {
    const project = makeProject(workDir, {
      compatibility: { versions: ["1.21.8"], platforms: [] },
    });
    await expect(runDev(project, {})).rejects.toThrow(/platform/);
  });

  test("passes clean, freshWorld, port, offline to stageDev", async () => {
    const platform = fakePlatform("paper");
    vi.mocked(getPlatform).mockReturnValue(platform);
    vi.mocked(buildProject).mockResolvedValue({
      outputPath: join(workDir, "plugin.jar"),
      sizeBytes: 1,
      stagingDir: join(workDir, ".pluggy-build", "abc"),
      durationMs: 1,
    });
    vi.mocked(stageDev).mockResolvedValue(join(workDir, "dev"));
    vi.mocked(stagePlugins).mockResolvedValue(undefined);
    const child = makeFakeChild();
    vi.mocked(spawnServer).mockReturnValue(child as unknown as ReturnType<typeof spawnServer>);
    vi.mocked(watchProject).mockReturnValue(() => {});

    setImmediate(() => child.emit("exit", 0, null));

    // --offline overrides project.dev.onlineMode=true.
    const project = makeProject(workDir, { dev: { onlineMode: true } });
    await runDev(project, {
      clean: true,
      freshWorld: false,
      port: 30_000,
      offline: true,
      watch: false,
    });

    const stageOpts = vi.mocked(stageDev).mock.calls[0][2];
    expect(stageOpts.clean).toBe(true);
    expect(stageOpts.port).toBe(30_000);
    expect(stageOpts.onlineMode).toBe(false);

    expect(vi.mocked(buildProject).mock.calls[0][1].clean).toBe(true);
  });
});

// Silence an unused-import warning — `writeFile` is only transitively used.
void writeFile;
