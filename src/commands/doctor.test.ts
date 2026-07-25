/**
 * Tests for src/commands/doctor.ts. External-effect checks (java spawn,
 * HEAD requests, cache stat) are replaced via the `checks` hook.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import type { ResolvedProject } from "../project.ts";

import yazl from "yazl";
import { createWriteStream } from "node:fs";

import { initLogging } from "../logging.ts";
import {
  checkDependencyJars,
  checkDescriptors,
  checkJava,
  checkLockfile,
  checkProjectValid,
  checkWorkspaceGraph,
  type CheckResult,
  type DoctorCommandOptions,
  remedyOf,
  runDoctorCommand,
} from "./doctor.ts";
import { resolveWorkspaceContext } from "../workspace.ts";

function passingHooks(): DoctorCommandOptions["checks"] {
  const pass = (id: string, label: string): CheckResult => ({
    id,
    label,
    status: "pass",
    detail: "ok",
  });
  return {
    java: async () => pass("java", "Java toolchain"),
    sdk: async () => pass("sdk", "Project JDK"),
    cache: async () => pass("cache", "Cache reachability"),
    registries: async () => [pass("registry", "Registries")],
    project: () => pass("project", "project.json"),
    workspace: () => pass("workspace", "Workspace graph"),
    descriptor: () => [pass("descriptor", "Descriptor family")],
    outdated: async () => pass("outdated", "Outdated dependencies"),
    dependencyJars: async () => pass("dep-jars", "Dependency compatibility"),
  };
}

function failingJavaCheck(): CheckResult {
  return {
    id: "java",
    label: "Java toolchain",
    status: "fail",
    detail: "not found",
    remedy: { kind: "run", command: "pluggy sdk install temurin@21" },
  };
}

/** Lockfile for a project named `withdep`: one declared entry, one orphan. */
function lockWithOrphan(): Record<string, unknown> {
  return {
    version: 2,
    entries: {
      "kept-plugin": {
        source: { kind: "modrinth", slug: "kept-plugin", version: "1.0.0" },
        resolvedVersion: "1.0.0",
        integrity: "sha256-aaa",
        declaredBy: ["withdep"],
      },
      "orphan-plugin": {
        source: { kind: "modrinth", slug: "orphan-plugin", version: "1.0.0" },
        resolvedVersion: "1.0.0",
        integrity: "sha256-bbb",
        declaredBy: [],
      },
    },
  };
}

describe("runDoctorCommand", () => {
  let rootDir: string;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "pluggy-doctor-"));
    stdoutSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    initLogging({ json: false, verbose: false, noColor: true });
    await writeFile(
      join(rootDir, "project.json"),
      JSON.stringify({
        name: "valid",
        version: "1.0.0",
        main: "com.example.Main",
        compatibility: { versions: ["1.21.8"], platforms: ["paper"] },
      }),
    );
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    vi.restoreAllMocks();
    initLogging({ json: false, verbose: false, noColor: true });
  });

  test("all checks pass → exitCode 0, ok=true", async () => {
    const res = await runDoctorCommand({ cwd: rootDir, checks: passingHooks() });
    expect(res.ok).toBe(true);
    expect(res.exitCode).toBe(0);
    expect(res.checks.length).toBeGreaterThan(0);
    for (const c of res.checks) {
      expect(c.status).toBe("pass");
    }
  });

  test("one fail → exitCode 1, result contains the failure", async () => {
    const hooks = passingHooks()!;
    hooks.java = async () => failingJavaCheck();

    const res = await runDoctorCommand({ cwd: rootDir, checks: hooks });
    expect(res.ok).toBe(false);
    expect(res.exitCode).toBe(1);
    const fails = res.checks.filter((c) => c.status === "fail");
    expect(fails).toHaveLength(1);
    expect(fails[0].id).toBe("java");
  });

  test("a remedy renders on its own line under its check", async () => {
    const hooks = passingHooks()!;
    hooks.java = async () => failingJavaCheck();
    hooks.cache = async () => ({
      id: "cache",
      label: "Cache reachability",
      status: "fail",
      detail: "cache is not writable: /tmp/pluggy",
      remedy: { kind: "manual", instruction: "grant your user write access to /tmp/pluggy" },
    });

    await runDoctorCommand({ cwd: rootDir, checks: hooks });

    const lines = stdoutSpy.mock.calls.flatMap((c: unknown[]) => String(c[0]).split("\n"));
    const javaIndex = lines.findIndex((l: string) => l.includes("Java toolchain: not found"));
    expect(javaIndex).toBeGreaterThanOrEqual(0);
    expect(lines[javaIndex]).not.toContain("→");
    expect(lines[javaIndex + 1]).toMatch(/^\s+→ pluggy sdk install temurin@21$/);

    const manualLine = lines.find((l: string) => l.includes("grant your user write access"));
    expect(manualLine).toMatch(/^\s+→ /);
    expect(manualLine).toContain("(no automatic fix)");

    const passLine = lines.find((l: string) => l.includes("Registries"));
    expect(passLine).not.toContain("→");
  });

  test("warn does not fail the overall result", async () => {
    const hooks = passingHooks()!;
    hooks.outdated = async () => ({
      id: "outdated",
      label: "Outdated deps",
      status: "warn",
      detail: "(not yet implemented)",
    });
    const res = await runDoctorCommand({ cwd: rootDir, checks: hooks });
    expect(res.ok).toBe(true);
    expect(res.exitCode).toBe(0);
  });

  test("JSON mode, success: single JSON blob on stdout", async () => {
    initLogging({ json: true });
    await runDoctorCommand({ cwd: rootDir, checks: passingHooks() });
    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(stdoutSpy.mock.calls[0][0] as string);
    expect(parsed.ok).toBe(true);
    expect(Array.isArray(parsed.checks)).toBe(true);
    expect(parsed.failures).toEqual([]);
    expect(parsed.environment).toBeDefined();
    expect(parsed.environment.pluggy).toBeDefined();
    expect(parsed.summary).toBeDefined();
    expect(parsed.summary.passed).toBeGreaterThan(0);
  });

  test("JSON mode, failure: JSON blob on stderr with failures[]", async () => {
    const hooks = passingHooks()!;
    hooks.java = async () => failingJavaCheck();
    initLogging({ json: true });
    const res = await runDoctorCommand({ cwd: rootDir, checks: hooks });
    expect(res.ok).toBe(false);
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(stderrSpy.mock.calls[0][0] as string);
    expect(parsed.ok).toBe(false);
    expect(parsed.failures).toHaveLength(1);
    expect(parsed.failures[0].id).toBe("java");
    expect(parsed.failures[0].remedy).toEqual({
      kind: "run",
      command: "pluggy sdk install temurin@21",
    });
    const javaCheck = parsed.checks.find((c: { id: string }) => c.id === "java");
    expect(javaCheck.remedy.command).toBe("pluggy sdk install temurin@21");
  });

  test("missing project produces a project-found failure but still emits environment", async () => {
    const empty = await mkdtemp(join(tmpdir(), "pluggy-doctor-empty-"));
    try {
      const res = await runDoctorCommand({ cwd: empty });
      expect(res.ok).toBe(false);
      expect(res.exitCode).toBe(1);
      expect(res.checks).toHaveLength(1);
      expect(res.checks[0].id).toBe("project-found");
      expect(res.checks[0].status).toBe("fail");
      expect(res.environment.pluggy.version).toBeDefined();
      expect(res.environment.project).toBeUndefined();
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  test("environment is populated with pluggy.version, os.platform, runtime.name", async () => {
    const res = await runDoctorCommand({
      cwd: rootDir,
      checks: passingHooks(),
      pluggyVersion: "1.2.3",
    });
    expect(res.environment.pluggy.version).toBe("1.2.3");
    expect(typeof res.environment.os.platform).toBe("string");
    expect(res.environment.os.platform.length).toBeGreaterThan(0);
    expect(res.environment.runtime.name === "bun" || res.environment.runtime.name === "node").toBe(
      true,
    );
    expect(typeof res.environment.runtime.version).toBe("string");
    expect(res.environment.runtime.version.length).toBeGreaterThan(0);
  });

  test("envVarsSet includes a tracked name when set, omits it when unset", async () => {
    const original = process.env.PLUGGY_NO_AUTO_INSTALL;
    delete process.env.PLUGGY_NO_AUTO_INSTALL;
    try {
      const without = await runDoctorCommand({ cwd: rootDir, checks: passingHooks() });
      expect(without.environment.envVarsSet).not.toContain("PLUGGY_NO_AUTO_INSTALL");

      process.env.PLUGGY_NO_AUTO_INSTALL = "1";
      const withVar = await runDoctorCommand({ cwd: rootDir, checks: passingHooks() });
      expect(withVar.environment.envVarsSet).toContain("PLUGGY_NO_AUTO_INSTALL");
    } finally {
      if (original === undefined) delete process.env.PLUGGY_NO_AUTO_INSTALL;
      else process.env.PLUGGY_NO_AUTO_INSTALL = original;
    }
  });

  test("envVarsSet records names only, never values", async () => {
    const original = process.env.PLUGGY_NO_UPDATE_CHECK;
    process.env.PLUGGY_NO_UPDATE_CHECK = "supersecret-sentinel-12345";
    try {
      const res = await runDoctorCommand({ cwd: rootDir, checks: passingHooks() });
      expect(res.environment.envVarsSet).toContain("PLUGGY_NO_UPDATE_CHECK");
      for (const name of res.environment.envVarsSet) {
        expect(name).not.toContain("supersecret-sentinel-12345");
      }
      const serialized = JSON.stringify(res.environment);
      expect(serialized).not.toContain("supersecret-sentinel-12345");
    } finally {
      if (original === undefined) delete process.env.PLUGGY_NO_UPDATE_CHECK;
      else process.env.PLUGGY_NO_UPDATE_CHECK = original;
    }
  });

  test("--json with --report records that --report was ignored", async () => {
    initLogging({ json: true });
    await runDoctorCommand({ cwd: rootDir, checks: passingHooks(), report: true });
    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(stdoutSpy.mock.calls[0][0] as string);
    expect(parsed.warnings).toEqual(["--report was ignored because --json was set"]);
  });

  test("--report emits markdown wrapped in <details>", async () => {
    await runDoctorCommand({ cwd: rootDir, checks: passingHooks(), report: true });
    expect(stdoutSpy).toHaveBeenCalled();
    const output = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(output.startsWith("<details>")).toBe(true);
    expect(output).toContain("pluggy doctor report");
    expect(output.trimEnd().endsWith("</details>")).toBe(true);
  });

  test("lockfile with orphan transitive yields warn and orphans=1", async () => {
    await writeFile(
      join(rootDir, "project.json"),
      JSON.stringify({
        name: "withdep",
        version: "1.0.0",
        main: "com.example.Main",
        compatibility: { versions: ["1.21.8"], platforms: ["paper"] },
        dependencies: {
          "kept-plugin": { source: "modrinth:kept-plugin", version: "*" },
        },
      }),
    );
    await writeFile(join(rootDir, "pluggy.lock"), JSON.stringify(lockWithOrphan()));

    // Hooks short-circuit network/cache/jvm checks; we only care about checkLockfile.
    const hooks = passingHooks()!;
    const res = await runDoctorCommand({ cwd: rootDir, checks: hooks });
    const lockCheck = res.checks.find((c) => c.id === "lockfile");
    expect(lockCheck).toBeDefined();
    expect(lockCheck!.status).toBe("warn");
    expect(lockCheck!.detail).toMatch(/orphan/);
    expect(res.environment.lockfile).toBeDefined();
    expect(res.environment.lockfile!.orphans).toBe(1);
    expect(res.environment.lockfile!.entries).toBe(2);
    expect(res.environment.lockfile!.topLevel).toBe(1);
  });
});

describe("checkProjectValid", () => {
  function makeProject(overrides: Partial<ResolvedProject> = {}): ResolvedProject {
    return {
      name: "goodname",
      version: "1.0.0",
      main: "com.example.Main",
      compatibility: { versions: ["1.21.8"], platforms: ["paper"] },
      rootDir: "/tmp/x",
      projectFile: "/tmp/x/project.json",
      ...overrides,
    };
  }

  test("valid project passes", () => {
    const r = checkProjectValid(makeProject());
    expect(r.status).toBe("pass");
  });

  test("hyphenated name passes", () => {
    const r = checkProjectValid(makeProject({ name: "my-plugin" }));
    expect(r.status).toBe("pass");
  });

  test("missing name → fail, names the field", () => {
    const r = checkProjectValid(makeProject({ name: undefined as unknown as string }));
    expect(r.status).toBe("fail");
    expect(r.detail).toMatch(/name/);
  });

  test("bad version → fail, names the field", () => {
    const r = checkProjectValid(makeProject({ version: "not-semver" }));
    expect(r.status).toBe("fail");
    expect(r.detail).toMatch(/version/);
  });

  test("unknown platform → fail, names the platform", () => {
    const r = checkProjectValid(
      makeProject({ compatibility: { versions: ["1.21.8"], platforms: ["not-a-platform"] } }),
    );
    expect(r.status).toBe("fail");
    expect(r.detail).toMatch(/not-a-platform/);
  });
});

describe("checkWorkspaceGraph", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "pluggy-doctor-ws-"));
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  test("standalone passes", async () => {
    await writeFile(
      join(rootDir, "project.json"),
      JSON.stringify({
        name: "solo",
        version: "1.0.0",
        main: "com.example.Main",
        compatibility: { versions: ["1.21.8"], platforms: ["paper"] },
      }),
    );
    const ctx = resolveWorkspaceContext(rootDir)!;
    expect(checkWorkspaceGraph(ctx).status).toBe("pass");
  });

  test("cycle is detected as a failure", async () => {
    await mkdir(join(rootDir, "modules", "a"), { recursive: true });
    await mkdir(join(rootDir, "modules", "b"), { recursive: true });
    await writeFile(
      join(rootDir, "project.json"),
      JSON.stringify({
        name: "r",
        version: "1.0.0",
        compatibility: { versions: ["1.21.8"], platforms: ["paper"] },
        workspaces: ["./modules/a", "./modules/b"],
      }),
    );
    await writeFile(
      join(rootDir, "modules", "a", "project.json"),
      JSON.stringify({
        name: "a",
        version: "0.1.0",
        main: "a.M",
        dependencies: { b: { source: "workspace:b", version: "*" } },
      }),
    );
    await writeFile(
      join(rootDir, "modules", "b", "project.json"),
      JSON.stringify({
        name: "b",
        version: "0.1.0",
        main: "b.M",
        dependencies: { a: { source: "workspace:a", version: "*" } },
      }),
    );
    const ctx = resolveWorkspaceContext(rootDir)!;
    const r = checkWorkspaceGraph(ctx);
    expect(r.status).toBe("fail");
    expect(r.detail).toMatch(/cycle/);
  });
});

describe("checkDescriptors", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "pluggy-doctor-desc-"));
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  test("standalone with consistent platform family passes", async () => {
    await writeFile(
      join(rootDir, "project.json"),
      JSON.stringify({
        name: "solo",
        version: "1.0.0",
        main: "com.example.Main",
        compatibility: { versions: ["1.21.8"], platforms: ["paper"] },
      }),
    );
    const ctx = resolveWorkspaceContext(rootDir)!;
    const results = checkDescriptors(ctx);
    expect(results.every((r) => r.status === "pass")).toBe(true);
  });

  test("cross-family platform declaration → fail", async () => {
    await writeFile(
      join(rootDir, "project.json"),
      JSON.stringify({
        name: "solo",
        version: "1.0.0",
        main: "com.example.Main",
        compatibility: { versions: ["1.21.8"], platforms: ["paper", "velocity"] },
      }),
    );
    const ctx = resolveWorkspaceContext(rootDir)!;
    const results = checkDescriptors(ctx);
    const failing = results.filter((r) => r.status === "fail");
    expect(failing.length).toBeGreaterThan(0);
    expect(failing[0].detail).toMatch(/different descriptor families|family/);
  });
});

// ---------------------------------------------------------------------------
// checkJava
// ---------------------------------------------------------------------------

describe("checkJava", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "pluggy-doctor-java-"));
    await writeFile(
      join(rootDir, "project.json"),
      JSON.stringify({
        name: "test",
        version: "1.0.0",
        main: "com.example.Main",
        compatibility: { versions: ["1.21.8"], platforms: ["paper"] },
      }),
    );
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  test("passes when java version is provided for non-BuildTools platform", async () => {
    const ctx = resolveWorkspaceContext(rootDir)!;
    const r = await checkJava(ctx, 21);
    expect(r.status).toBe("pass");
    expect(r.detail).toBe("Java 21");
  });

  test("fails when javaError is provided", async () => {
    const ctx = resolveWorkspaceContext(rootDir)!;
    const r = await checkJava(ctx, undefined, "not found");
    expect(r.status).toBe("fail");
    expect(r.detail).toMatch(/not found/);
  });

  test("fails when userJava is undefined and no error", async () => {
    const ctx = resolveWorkspaceContext(rootDir)!;
    const r = await checkJava(ctx, undefined);
    expect(r.status).toBe("fail");
  });

  test("warns for spigot when java is below BuildTools floor (no jar cached)", async () => {
    await writeFile(
      join(rootDir, "project.json"),
      JSON.stringify({
        name: "test",
        version: "1.0.0",
        main: "com.example.Main",
        compatibility: { versions: ["1.21.8"], platforms: ["spigot"] },
      }),
    );
    const ctx = resolveWorkspaceContext(rootDir)!;
    // No BuildTools.jar cached → floor defaults to 8. Java 7 < 8 → warn.
    const r = await checkJava(ctx, 7);
    expect(r.status).toBe("warn");
    expect(r.detail).toMatch(/BuildTools requires Java/);
  });

  test("passes for spigot when java meets the floor", async () => {
    await writeFile(
      join(rootDir, "project.json"),
      JSON.stringify({
        name: "test",
        version: "1.0.0",
        main: "com.example.Main",
        compatibility: { versions: ["1.21.8"], platforms: ["spigot"] },
      }),
    );
    const ctx = resolveWorkspaceContext(rootDir)!;
    const r = await checkJava(ctx, 21);
    expect(r.status).toBe("pass");
  });
});

// ---------------------------------------------------------------------------
// checkDependencyJars
// ---------------------------------------------------------------------------

async function makeJar(path: string, entries: Record<string, Buffer | string>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const zip = new yazl.ZipFile();
    const ws = createWriteStream(path);
    ws.once("error", reject);
    ws.once("close", resolve);
    zip.outputStream.pipe(ws);
    for (const [name, content] of Object.entries(entries)) {
      const buf = typeof content === "string" ? Buffer.from(content, "utf8") : content;
      zip.addBuffer(buf, name);
    }
    zip.end();
  });
}

function classBytes(major: number): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(0xcafebabe, 0);
  buf.writeUInt16BE(0, 4);
  buf.writeUInt16BE(major, 6);
  return buf;
}

describe("checkDependencyJars", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "pluggy-doctor-depjars-"));
    await writeFile(
      join(rootDir, "project.json"),
      JSON.stringify({
        name: "test",
        version: "1.0.0",
        main: "com.example.Main",
        compatibility: { versions: ["1.21.8"], platforms: ["paper"] },
      }),
    );
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  test("passes with no lockfile", async () => {
    const ctx = resolveWorkspaceContext(rootDir)!;
    const r = await checkDependencyJars(ctx, 21);
    expect(r.status).toBe("pass");
    expect(r.detail).toMatch(/no dependencies/);
  });

  test("skips when userJava is undefined", async () => {
    await writeFile(
      join(rootDir, "pluggy.lock"),
      JSON.stringify({
        version: 2,
        entries: {
          "some-plugin": {
            source: { kind: "modrinth", slug: "some-plugin", version: "1.0.0" },
            resolvedVersion: "1.0.0",
            integrity: "sha256-aaa",
            declaredBy: ["test"],
          },
        },
      }),
    );
    const ctx = resolveWorkspaceContext(rootDir)!;
    const r = await checkDependencyJars(ctx, undefined);
    expect(r.status).toBe("pass");
    expect(r.detail).toMatch(/skipped/);
  });

  test("passes when no cached jars exist on disk", async () => {
    await writeFile(
      join(rootDir, "pluggy.lock"),
      JSON.stringify({
        version: 2,
        entries: {
          "some-plugin": {
            source: { kind: "modrinth", slug: "some-plugin", version: "1.0.0" },
            resolvedVersion: "1.0.0",
            integrity: "sha256-aaa",
            declaredBy: ["test"],
          },
        },
      }),
    );
    const ctx = resolveWorkspaceContext(rootDir)!;
    const r = await checkDependencyJars(ctx, 21);
    expect(r.status).toBe("pass");
    expect(r.detail).toMatch(/no cached jars/);
  });

  test("warns when a cached jar requires higher Java than available", async () => {
    const { getCachePath } = await import("../project.ts");
    const cacheDir = join(getCachePath(), "dependencies", "modrinth", "heavy-dep");
    await mkdir(cacheDir, { recursive: true });
    const jarPath = join(cacheDir, "2.0.0.jar");
    await makeJar(jarPath, { "com/example/Plugin.class": classBytes(65) }); // Java 21

    await writeFile(
      join(rootDir, "pluggy.lock"),
      JSON.stringify({
        version: 2,
        entries: {
          "heavy-dep": {
            source: { kind: "modrinth", slug: "heavy-dep", version: "2.0.0" },
            resolvedVersion: "2.0.0",
            integrity: "sha256-aaa",
            declaredBy: ["test"],
          },
        },
      }),
    );

    const ctx = resolveWorkspaceContext(rootDir)!;
    const r = await checkDependencyJars(ctx, 17); // user has Java 17, dep needs 21
    expect(r.status).toBe("warn");
    expect(r.detail).toMatch(/heavy-dep/);
    expect(r.detail).toMatch(/Java 21/);

    // cleanup
    await rm(cacheDir, { recursive: true, force: true });
  });

  test("passes when all cached jars are compatible", async () => {
    const { getCachePath } = await import("../project.ts");
    const cacheDir = join(getCachePath(), "dependencies", "modrinth", "compat-dep");
    await mkdir(cacheDir, { recursive: true });
    const jarPath = join(cacheDir, "1.0.0.jar");
    await makeJar(jarPath, { "com/example/Plugin.class": classBytes(61) }); // Java 17

    await writeFile(
      join(rootDir, "pluggy.lock"),
      JSON.stringify({
        version: 2,
        entries: {
          "compat-dep": {
            source: { kind: "modrinth", slug: "compat-dep", version: "1.0.0" },
            resolvedVersion: "1.0.0",
            integrity: "sha256-aaa",
            declaredBy: ["test"],
          },
        },
      }),
    );

    const ctx = resolveWorkspaceContext(rootDir)!;
    const r = await checkDependencyJars(ctx, 21); // user has Java 21, dep needs 17
    expect(r.status).toBe("pass");
    expect(r.detail).toMatch(/compatible with Java 21/);

    // cleanup
    await rm(cacheDir, { recursive: true, force: true });
  });
});

describe("remedies", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "pluggy-doctor-remedy-"));
    initLogging({ json: false, verbose: false, noColor: true });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  test("every failing check carries an actionable remedy", async () => {
    const project = (overrides: Partial<ResolvedProject>): ResolvedProject => ({
      name: "solo",
      version: "1.0.0",
      main: "com.example.Main",
      compatibility: { versions: ["1.21.8"], platforms: ["paper"] },
      rootDir,
      projectFile: join(rootDir, "project.json"),
      ...overrides,
    });

    // A project that fails several checks at once: mixed descriptor families
    // and an unparseable lockfile.
    await writeFile(
      join(rootDir, "project.json"),
      JSON.stringify({
        name: "mixed",
        version: "1.0.0",
        main: "com.example.Main",
        compatibility: { versions: ["1.21.8"], platforms: ["paper", "velocity"] },
      }),
    );
    await writeFile(join(rootDir, "pluggy.lock"), "{ not json");
    const ctx = resolveWorkspaceContext(rootDir)!;

    const cycleDir = join(rootDir, "cyclic");
    await mkdir(join(cycleDir, "a"), { recursive: true });
    await mkdir(join(cycleDir, "b"), { recursive: true });
    await writeFile(
      join(cycleDir, "project.json"),
      JSON.stringify({
        name: "r",
        version: "1.0.0",
        compatibility: { versions: ["1.21.8"], platforms: ["paper"] },
        workspaces: ["./a", "./b"],
      }),
    );
    await writeFile(
      join(cycleDir, "a", "project.json"),
      JSON.stringify({
        name: "a",
        version: "0.1.0",
        main: "a.M",
        dependencies: { b: { source: "workspace:b", version: "*" } },
      }),
    );
    await writeFile(
      join(cycleDir, "b", "project.json"),
      JSON.stringify({
        name: "b",
        version: "0.1.0",
        main: "b.M",
        dependencies: { a: { source: "workspace:a", version: "*" } },
      }),
    );

    const noProjectDir = await mkdtemp(join(tmpdir(), "pluggy-doctor-noproject-"));
    const staleDir = await mkdtemp(join(tmpdir(), "pluggy-doctor-stale-"));
    await writeFile(
      join(staleDir, "project.json"),
      JSON.stringify({
        name: "suite",
        version: "1.0.0",
        compatibility: { versions: ["1.21.8"], platforms: ["paper"] },
        workspaces: ["./gone"],
      }),
    );

    try {
      const results: CheckResult[] = [
        checkProjectValid(project({ name: "not a name" })),
        checkProjectValid(project({ version: "not-semver" })),
        checkProjectValid(project({ compatibility: undefined })),
        checkProjectValid(
          project({ compatibility: { versions: ["1.21.8"], platforms: ["not-a-platform"] } }),
        ),
        await checkJava(ctx, undefined, "spawn java ENOENT"),
        await checkJava(ctx, undefined),
        checkLockfile(ctx),
        ...checkDescriptors(ctx),
        checkWorkspaceGraph(resolveWorkspaceContext(cycleDir)!),
        ...(await runDoctorCommand({ cwd: noProjectDir })).checks,
        ...(await runDoctorCommand({ cwd: staleDir })).checks,
      ];

      const failures = results.filter((r) => r.status === "fail");
      expect(failures).toHaveLength(results.length);

      for (const failure of failures) {
        const remedy = remedyOf(failure);
        expect(remedy, `${failure.id} (${failure.label}) has no remedy`).toBeDefined();
        if (remedy?.kind === "run") {
          expect(remedy.command.startsWith("pluggy ")).toBe(true);
        } else {
          expect(remedy?.instruction.length).toBeGreaterThan(0);
        }
      }
    } finally {
      await rm(noProjectDir, { recursive: true, force: true });
      await rm(staleDir, { recursive: true, force: true });
    }
  });

  test("remediation prose lives in the remedy, not in the detail", async () => {
    await writeFile(
      join(rootDir, "project.json"),
      JSON.stringify({
        name: "withdep",
        version: "1.0.0",
        main: "com.example.Main",
        compatibility: { versions: ["1.21.8"], platforms: ["paper"] },
        dependencies: { "kept-plugin": { source: "modrinth:kept-plugin", version: "*" } },
      }),
    );
    await writeFile(join(rootDir, "pluggy.lock"), JSON.stringify(lockWithOrphan()));

    const ctx = resolveWorkspaceContext(rootDir)!;
    const result = checkLockfile(ctx);
    expect(result.status).toBe("warn");
    expect(result.detail).not.toMatch(/pluggy install/);
    expect(remedyOf(result)).toEqual({ kind: "run", command: "pluggy install", auto: true });
  });
});

describe("runDoctorCommand --fix", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "pluggy-doctor-fix-"));
    initLogging({ json: false, verbose: false, noColor: true });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  test("drops missing-folder workspace entries from root project.json", async () => {
    await mkdir(join(rootDir, "api"), { recursive: true });
    await writeFile(
      join(rootDir, "project.json"),
      JSON.stringify({
        name: "suite",
        version: "1.0.0",
        compatibility: { versions: ["1.21.8"], platforms: ["paper"] },
        // `./missing` points nowhere; --fix should drop it.
        workspaces: ["./api", "./missing"],
      }),
    );
    await writeFile(
      join(rootDir, "api", "project.json"),
      JSON.stringify({ name: "api", version: "0.1.0" }),
    );

    const res = await runDoctorCommand({
      cwd: rootDir,
      fix: true,
      // Stub the heavy hooks; we only care about the fix path here.
      checks: passingHooks(),
    });

    expect(res.fixes).toBeDefined();
    expect(res.fixes?.some((f) => f.id === "workspace-prune")).toBe(true);

    // Verify the root project.json was rewritten without the missing entry.
    const reread = JSON.parse(
      await import("node:fs/promises").then((fs) =>
        fs.readFile(join(rootDir, "project.json"), "utf8"),
      ),
    );
    expect(reread.workspaces).toEqual(["./api"]);
  });

  test("no --fix: no fixes applied even when fixable issues exist", async () => {
    await mkdir(join(rootDir, "api"), { recursive: true });
    await writeFile(
      join(rootDir, "project.json"),
      JSON.stringify({
        name: "suite",
        version: "1.0.0",
        compatibility: { versions: ["1.21.8"], platforms: ["paper"] },
        workspaces: ["./api"],
      }),
    );
    await writeFile(
      join(rootDir, "api", "project.json"),
      JSON.stringify({ name: "api", version: "0.1.0" }),
    );

    const res = await runDoctorCommand({
      cwd: rootDir,
      checks: passingHooks(),
    });
    expect(res.fixes).toBeUndefined();
  });

  test("without --fix, missing workspace entries fail with an auto remedy", async () => {
    await mkdir(join(rootDir, "api"), { recursive: true });
    await writeFile(
      join(rootDir, "project.json"),
      JSON.stringify({
        name: "suite",
        version: "1.0.0",
        compatibility: { versions: ["1.21.8"], platforms: ["paper"] },
        workspaces: ["./api", "./missing"],
      }),
    );
    await writeFile(
      join(rootDir, "api", "project.json"),
      JSON.stringify({ name: "api", version: "0.1.0" }),
    );

    const res = await runDoctorCommand({ cwd: rootDir, checks: passingHooks() });

    expect(res.ok).toBe(false);
    expect(res.checks).toHaveLength(1);
    expect(res.checks[0].id).toBe("workspace-entries");
    expect(res.checks[0].detail).toContain("./missing");
    expect(remedyOf(res.checks[0])).toEqual({
      kind: "run",
      command: "pluggy doctor --fix",
      auto: true,
    });
    expect(res.fixes).toBeUndefined();

    const reread = JSON.parse(await readFile(join(rootDir, "project.json"), "utf8"));
    expect(reread.workspaces).toEqual(["./api", "./missing"]);
  });

  test("applies the lockfile remedy, which is marked auto", async () => {
    await writeFile(
      join(rootDir, "project.json"),
      JSON.stringify({
        name: "withdep",
        version: "1.0.0",
        main: "com.example.Main",
        compatibility: { versions: ["1.21.8"], platforms: ["paper"] },
        dependencies: { "kept-plugin": { source: "modrinth:kept-plugin", version: "*" } },
      }),
    );
    await writeFile(join(rootDir, "pluggy.lock"), JSON.stringify(lockWithOrphan()));

    const res = await runDoctorCommand({ cwd: rootDir, fix: true, checks: passingHooks() });

    expect(res.fixes?.map((f) => f.id)).toEqual(["lockfile-prune"]);
    const lock = JSON.parse(await readFile(join(rootDir, "pluggy.lock"), "utf8"));
    expect(Object.keys(lock.entries)).toEqual(["kept-plugin"]);
  });

  test("ignores a remedy that is not marked auto", async () => {
    // No declared deps, so the real lockfile check never runs: the injected
    // check is the only one carrying id "lockfile", and its remedy is manual.
    await writeFile(
      join(rootDir, "project.json"),
      JSON.stringify({
        name: "withdep",
        version: "1.0.0",
        main: "com.example.Main",
        compatibility: { versions: ["1.21.8"], platforms: ["paper"] },
      }),
    );
    await writeFile(join(rootDir, "pluggy.lock"), JSON.stringify(lockWithOrphan()));

    const hooks = passingHooks()!;
    hooks.outdated = async () => ({
      id: "lockfile",
      label: "Lockfile",
      status: "warn",
      detail: "1 orphan transitive",
      remedy: { kind: "run", command: "pluggy install" },
    });

    const res = await runDoctorCommand({ cwd: rootDir, fix: true, checks: hooks });

    expect(res.fixes).toBeUndefined();
    const lock = JSON.parse(await readFile(join(rootDir, "pluggy.lock"), "utf8"));
    expect(Object.keys(lock.entries)).toEqual(["kept-plugin", "orphan-plugin"]);
  });

  test("applies the same remedy when the check marks it auto", async () => {
    await writeFile(
      join(rootDir, "project.json"),
      JSON.stringify({
        name: "withdep",
        version: "1.0.0",
        main: "com.example.Main",
        compatibility: { versions: ["1.21.8"], platforms: ["paper"] },
      }),
    );
    await writeFile(join(rootDir, "pluggy.lock"), JSON.stringify(lockWithOrphan()));

    const hooks = passingHooks()!;
    hooks.outdated = async () => ({
      id: "lockfile",
      label: "Lockfile",
      status: "warn",
      detail: "1 orphan transitive",
      remedy: { kind: "run", command: "pluggy install", auto: true },
    });

    const res = await runDoctorCommand({ cwd: rootDir, fix: true, checks: hooks });

    expect(res.fixes?.map((f) => f.id)).toEqual(["lockfile-prune"]);
    const lock = JSON.parse(await readFile(join(rootDir, "pluggy.lock"), "utf8"));
    expect(Object.keys(lock.entries)).toEqual(["kept-plugin"]);
  });
});
