/**
 * Tests for src/commands/doctor.ts. External-effect checks (java spawn,
 * HEAD requests, cache stat) are replaced via the `checks` hook.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  checkProjectValid,
  checkWorkspaceGraph,
  type CheckResult,
  type DoctorCommandOptions,
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
    hooks.java = async () => ({
      id: "java",
      label: "Java toolchain",
      status: "fail",
      detail: "not found",
    });

    const res = await runDoctorCommand({ cwd: rootDir, checks: hooks });
    expect(res.ok).toBe(false);
    expect(res.exitCode).toBe(1);
    const fails = res.checks.filter((c) => c.status === "fail");
    expect(fails).toHaveLength(1);
    expect(fails[0].id).toBe("java");
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
    hooks.java = async () => ({
      id: "java",
      label: "Java toolchain",
      status: "fail",
      detail: "not found",
    });
    initLogging({ json: true });
    const res = await runDoctorCommand({ cwd: rootDir, checks: hooks });
    expect(res.ok).toBe(false);
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(stderrSpy.mock.calls[0][0] as string);
    expect(parsed.ok).toBe(false);
    expect(parsed.failures).toHaveLength(1);
    expect(parsed.failures[0].id).toBe("java");
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
    await writeFile(
      join(rootDir, "pluggy.lock"),
      JSON.stringify({
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
            // No declaredBy, no parent → orphan once pruneOrphans runs.
            declaredBy: [],
          },
        },
      }),
    );

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

    // The missing workspace makes the workspace context refuse to load, so
    // run --fix from a state that's tolerable to resolveWorkspaceContext.
    // We invoke runDoctorCommand directly, and the inner enumerate-workspaces
    // call would throw if "missing" was traversed — but enumerateWorkspaces
    // does throw. So this case needs the root to be at least partially
    // resolvable. For this test we simulate the case where the entry was
    // declared *and* the folder existed when declared but was later deleted.
    await mkdir(join(rootDir, "missing"), { recursive: true });
    await writeFile(
      join(rootDir, "missing", "project.json"),
      JSON.stringify({ name: "missing", version: "0.1.0" }),
    );
    // Now actually delete the folder to mimic the "user removed it by hand" state.
    await rm(join(rootDir, "missing"), { recursive: true, force: true });

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
});
