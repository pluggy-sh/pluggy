/**
 * Test pipeline — resolve deps → compile src → package main.jar → compile
 * test → run JUnit Platform Console Launcher → parse JUnit XML reports.
 * Orchestration only; pure arg-building and report-parsing live in
 * `./runner.ts`.
 *
 * Main classes are zipped into a `main.jar` (with the generated descriptor
 * and any declared `resources`) and that jar — not the raw classes directory
 * — is what the test classpath sees. This mirrors how the plugin is loaded
 * in production and lets any framework that inspects the runtime classloader
 * (MockBukkit, agent-style harnesses, …) work without per-framework hooks.
 *
 * JUnit Platform Console Standalone is auto-injected from Maven Central; the
 * user never declares it. User-provided test deps go in `project.json`'s
 * `testDependencies`, resolved through the same pipeline as `dependencies`.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";

import { compileJava } from "../build/compile.ts";
import { pickDescriptor } from "../build/descriptor.ts";
import { zipDirectory } from "../build/jar.ts";
import { stageResources } from "../build/resources.ts";
import { log } from "../logging.ts";
import { getPlatform } from "../platform/index.ts";
import { writeFileLF } from "../portable.ts";
import type { ResolvedProject } from "../project.ts";
import { resolveDependency, type ResolvedDependency } from "../resolver/index.ts";
import { resolveMaven } from "../resolver/maven.ts";
import { ensureJdkForProject } from "../sdk/index.ts";
import { parseSource } from "../source.ts";

import {
  buildLauncherArgs,
  parseJUnitReports,
  type TestRunResult as ParsedRunResult,
} from "./runner.ts";

/** Maven Central — always appended to the test-time registry list. */
const MAVEN_CENTRAL = "https://repo1.maven.org/maven2";

/** Pinned JUnit Platform Console Standalone — single jar, includes Jupiter + Vintage. */
const JUNIT_CONSOLE = {
  groupId: "org.junit.platform",
  artifactId: "junit-platform-console-standalone",
  version: "1.11.4",
} as const;

const STAGING_ROOT = ".pluggy-build";
const MAX_STDERR_LINES = 40;

export interface TestRunOptions {
  /** Wipe the test staging dir (compiled classes, XML reports) before running. */
  clean?: boolean;
  /** User filter — see `filterToLauncherArgs`. */
  filter?: string;
  /** Stop on first test failure. */
  failFast?: boolean;
}

export type TestRunOutcome =
  | {
      status: "ok";
      durationMs: number;
      result: ParsedRunResult;
    }
  | {
      status: "no-tests";
      durationMs: number;
      /** Why no tests ran — surfaced to the user. */
      reason: "no-test-dir" | "no-sources";
    };

/**
 * Compile and run the test suite for one project. Throws on compile errors
 * or unexpected JVM failures; test *failures* (asserts/exceptions) return
 * normally inside `result.failed > 0` so the caller can aggregate.
 */
export async function runTests(
  project: ResolvedProject,
  opts: TestRunOptions = {},
): Promise<TestRunOutcome> {
  const started = Date.now();

  const testSourceDir = join(project.rootDir, "test");
  if (!(await isDirectory(testSourceDir))) {
    return { status: "no-tests", durationMs: Date.now() - started, reason: "no-test-dir" };
  }
  if (!(await hasJavaSources(testSourceDir))) {
    return { status: "no-tests", durationMs: Date.now() - started, reason: "no-sources" };
  }

  const stagingId = createHash("sha256")
    .update(`${project.name}\0${project.version}\0${project.rootDir}`)
    .digest("hex")
    .slice(0, 12);
  const stagingDir = join(project.rootDir, STAGING_ROOT, `${stagingId}-test`);

  if (opts.clean === true) {
    await rm(stagingDir, { recursive: true, force: true });
  }

  // Main classes are compiled directly into a stage dir we then zip into a
  // jar. Putting the *jar* (rather than the raw classes directory) on the test
  // classpath matches how the plugin is loaded in production: any framework
  // that does runtime classloader inspection — MockBukkit, agent-based test
  // tooling, anything that calls `Class.getProtectionDomain().getCodeSource()`
  // — sees a real jar URL and can find the descriptor on the classpath.
  const mainStageDir = join(stagingDir, "main-jar-stage");
  const mainJarPath = join(stagingDir, "main.jar");
  const mainRuntimeJarPath = join(stagingDir, "main-runtime.jar");
  const testClassesDir = join(stagingDir, "test-classes");
  const reportsDir = join(stagingDir, "reports");

  await mkdir(mainStageDir, { recursive: true });
  await mkdir(testClassesDir, { recursive: true });
  // The jars are regenerated from `mainStageDir` every run; the staleness
  // story matches `mainStageDir` (incremental between runs, full reset
  // under `--clean`). Drop the previous jars so a rebuild can't append
  // onto a half-written file.
  await rm(mainJarPath, { force: true });
  await rm(mainRuntimeJarPath, { force: true });
  // Reports are wiped per-run unconditionally so a stale TEST-*.xml from a
  // deleted class can't leak into this run's results.
  await rm(reportsDir, { recursive: true, force: true });
  await mkdir(reportsDir, { recursive: true });

  // Project-declared registries (strings or {url, ...}).
  const projectRegistries: string[] = [];
  for (const entry of project.registries ?? []) {
    projectRegistries.push(typeof entry === "string" ? entry : entry.url);
  }
  // Test-time registries always include Maven Central so JUnit can be fetched.
  const testRegistries = dedupe([...projectRegistries, MAVEN_CENTRAL]);

  const mainDeps = await resolveDeclared(project, "dependencies", projectRegistries);
  const platformApiJars = await resolvePlatformApiJars(project, projectRegistries);
  const mainClasspath = dedupe([...flattenJars(mainDeps.map((d) => d.dep)), ...platformApiJars]);

  const testDeps = await resolveDeclared(project, "testDependencies", testRegistries);
  const junit = await resolveMaven(
    JUNIT_CONSOLE.groupId,
    JUNIT_CONSOLE.artifactId,
    JUNIT_CONSOLE.version,
    {
      rootDir: project.rootDir,
      includePrerelease: false,
      force: false,
      registries: testRegistries,
    },
  );

  // We build two jars from the same staged directory:
  //
  //   * `main.jar` — the full jar, handed to the test JVM via the
  //     `pluggy.test.mainJar` system property. Mocking frameworks
  //     (MockBukkit, anything else that mounts a plugin classloader) load
  //     the plugin from this path so the entry-point class ends up under
  //     their own `ConfiguredPluginClassLoader`.
  //   * `main-runtime.jar` — same content minus the declared entry-point
  //     class. This jar goes on the system test classpath so plain
  //     utility classes are reachable for non-mocking unit tests, but the
  //     entry-point class is *not* — keeping it off the system loader is
  //     what lets the mocking framework own it cleanly. Without this
  //     split, Bukkit's `JavaPlugin requires a valid classloader` check
  //     fires when the framework tries to reload the plugin.
  //
  // Test compile classpath uses the full `main.jar` so test code can
  // import the entry-point class for `Main.class` references and similar.
  const testDepJars = flattenJars(testDeps.map((d) => d.dep));
  const testCompileClasspath = dedupe([
    mainJarPath,
    ...mainClasspath,
    ...testDepJars,
    junit.jarPath,
  ]);
  const testRuntimeClasspath = dedupe([
    mainRuntimeJarPath,
    ...mainClasspath,
    ...testDepJars,
    junit.jarPath,
  ]);

  // Resolve the JDK once and thread it through compile + launcher. Done up
  // front so a cache miss only blocks once per `pluggy test` run.
  const jdk = await ensureJdkForProject(project);

  await compileJava(project, {
    sourceDir: join(project.rootDir, "src"),
    outputDir: mainStageDir,
    classpath: mainClasspath,
    javacPath: jdk.javacPath,
  });

  await packageMainJar(project, mainStageDir, mainJarPath, mainRuntimeJarPath);

  await compileJava(project, {
    sourceDir: testSourceDir,
    outputDir: testClassesDir,
    classpath: testCompileClasspath,
    javacPath: jdk.javacPath,
  });

  const launcherArgs = buildLauncherArgs({
    consoleJar: junit.jarPath,
    classpath: [testClassesDir, ...testRuntimeClasspath],
    testClassesDir,
    reportsDir,
    systemProperties: buildTestSystemProperties(mainJarPath, mainDeps, testDeps),
    filter: opts.filter,
    failFast: opts.failFast,
  });

  const { exitCode, stderrTail } = await runJavaLauncher(jdk.javaPath, launcherArgs);

  const xmlDocs = await readReports(reportsDir);
  const result = parseJUnitReports(xmlDocs);

  // Non-zero exit plus zero reports → real launcher failure (classpath, JVM crash, …).
  if (exitCode !== 0 && result.total === 0) {
    throw new Error(
      `test: JUnit launcher exited with code ${exitCode} and produced no reports.${
        stderrTail.length > 0 ? `\n${stderrTail}` : ""
      }`,
    );
  }

  return { status: "ok", durationMs: Date.now() - started, result };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Stage the generated descriptor + declared resources alongside the compiled
 * classes in `mainStageDir`, then zip the directory into two jars:
 *
 *   * `mainJarPath` — full content, used by mocking frameworks via the
 *     `pluggy.test.mainJar` system property.
 *   * `mainRuntimeJarPath` — same content minus the declared entry-point
 *     class. Goes on the system test classpath so utility classes are
 *     reachable; the entry-point stays unreachable so the mocking
 *     framework's classloader can own it (see Bukkit's `JavaPlugin`
 *     classloader check).
 *
 * Shading is intentionally not applied: the test classpath already has
 * every dep jar on it explicitly, so re-shading their classes into the
 * jar would just produce duplicate-class warnings at test time.
 */
async function packageMainJar(
  project: ResolvedProject,
  mainStageDir: string,
  mainJarPath: string,
  mainRuntimeJarPath: string,
): Promise<void> {
  await stageResources(project, mainStageDir);

  const descriptor = pickDescriptor(project);
  const resources = project.resources;
  const userOwnsDescriptor =
    resources !== undefined &&
    resources !== null &&
    Object.prototype.hasOwnProperty.call(resources, descriptor.path);

  if (!userOwnsDescriptor) {
    const rendered = descriptor.generate(project);
    const dest = join(mainStageDir, descriptor.path);
    await mkdir(dirname(dest), { recursive: true });
    await writeFileLF(dest, rendered);
  }

  await zipDirectory(mainStageDir, mainJarPath);

  // `project.main` is required for any workspace that runs tests (it has a
  // `src/` to compile). If it's missing here, descriptor generation above
  // already threw with a clearer message — but be defensive.
  const mainEntry =
    project.main !== undefined && project.main.length > 0
      ? `${project.main.replace(/\./g, "/")}.class`
      : undefined;
  await zipDirectory(mainStageDir, mainRuntimeJarPath, {
    include: (rel) => mainEntry === undefined || rel !== mainEntry,
  });
}

/**
 * Build the system-property catalog handed to the test JVM.
 *
 * Three properties are exposed:
 *
 *   * `pluggy.test.mainJar` — absolute path to the plugin's own jar.
 *   * `pluggy.test.dependency.<name>` — one entry per declared dep
 *     (`project.dependencies` and `project.testDependencies`), keyed by
 *     the name from project.json. Picks of "load worldedit but not
 *     luckperms" use this.
 *   * `pluggy.test.dependencies` — `path.delimiter`-joined list of every
 *     declared dep jar in declaration order (`dependencies` first, then
 *     `testDependencies`). For "boot the server with everything declared".
 *
 * Transitive deps are intentionally not exposed: they're already on the
 * test classpath, and surfacing them would let callers depend on
 * indirect dep names that change without notice. Library-style Maven
 * deps may end up in the catalog — pluggy doesn't try to detect "is
 * this a plugin?", that's the test's call.
 *
 * On a name collision between `dependencies` and `testDependencies`,
 * the testDependency wins (last-write). Pluggy's resolver already
 * complains about ambiguous shapes upstream of this; if the same key
 * survives to here we just pick the test-time entry.
 */
function buildTestSystemProperties(
  mainJarPath: string,
  mainDeps: NamedDependency[],
  testDeps: NamedDependency[],
): Record<string, string> {
  const props: Record<string, string> = { "pluggy.test.mainJar": mainJarPath };
  const ordered: string[] = [];
  for (const { name, dep } of [...mainDeps, ...testDeps]) {
    props[`pluggy.test.dependency.${name}`] = dep.jarPath;
    ordered.push(dep.jarPath);
  }
  props["pluggy.test.dependencies"] = ordered.join(delimiter);
  return props;
}

async function runJavaLauncher(
  javaPath: string,
  args: string[],
): Promise<{ exitCode: number; stderrTail: string }> {
  log.debug(`java ${args.length} args (JUnit Console Launcher)`);
  // We render our own output from the XML reports afterwards, so the launcher's
  // own stdout/stderr are suppressed. stderr is still buffered so we can attach
  // the tail to an error message on an unexpected launcher failure.
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(javaPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stderrBuf: string[] = [];

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");

    // Drain stdout so the pipe doesn't fill up; discard its contents.
    child.stdout?.on("data", () => {});

    child.stderr?.on("data", (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (line.length === 0) continue;
        stderrBuf.push(line);
      }
    });

    child.once("error", (err) => {
      rejectPromise(new Error(`test: failed to spawn java: ${(err as Error).message}`));
    });

    child.once("close", (code) => {
      const tail = stderrBuf.slice(-MAX_STDERR_LINES).join("\n");
      resolvePromise({ exitCode: code ?? 0, stderrTail: tail });
    });
  });
}

async function readReports(reportsDir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(reportsDir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of entries) {
    if (!name.startsWith("TEST-") || !name.endsWith(".xml")) continue;
    try {
      out.push(await readFile(join(reportsDir, name), "utf8"));
    } catch {
      // File vanished or couldn't be read — skip, don't fail the whole run.
    }
  }
  return out;
}

interface NamedDependency {
  /** The key under `dependencies` / `testDependencies` in project.json. */
  name: string;
  dep: ResolvedDependency;
}

async function resolveDeclared(
  project: ResolvedProject,
  field: "dependencies" | "testDependencies",
  registries: string[],
): Promise<NamedDependency[]> {
  const declared = project[field];
  if (declared === undefined || declared === null) return [];

  const out: NamedDependency[] = [];
  for (const [name, raw] of Object.entries(declared)) {
    const { source, version } =
      typeof raw === "string"
        ? { source: `modrinth:${name}`, version: raw }
        : { source: raw.source, version: raw.version };
    const parsed = parseSource(source, version);
    const resolved = await resolveDependency(parsed, {
      rootDir: project.rootDir,
      includePrerelease: false,
      force: false,
      registries,
    });
    out.push({ name, dep: resolved });
  }
  return out;
}

async function resolvePlatformApiJars(
  project: ResolvedProject,
  projectRegistries: string[],
): Promise<string[]> {
  const platforms = project.compatibility?.platforms ?? [];
  const versions = project.compatibility?.versions ?? [];
  if (platforms.length === 0 || versions.length === 0) return [];

  let primary;
  try {
    primary = getPlatform(platforms[0]);
  } catch {
    return [];
  }

  const apiSpec = await primary.api(versions[0]);
  if (apiSpec.dependencies.length === 0) return [];

  const registries = dedupe([...apiSpec.repositories, ...projectRegistries]);

  const jars: string[] = [];
  for (const coord of apiSpec.dependencies) {
    const resolved = await resolveMaven(coord.groupId, coord.artifactId, coord.version, {
      rootDir: project.rootDir,
      includePrerelease: false,
      force: false,
      registries,
    });
    jars.push(...flattenJars([resolved]));
  }
  return dedupe(jars);
}

function flattenJars(deps: ResolvedDependency[]): string[] {
  const out: string[] = [];
  const visit = (d: ResolvedDependency): void => {
    out.push(d.jarPath);
    for (const t of d.transitiveDeps) visit(t);
  };
  for (const d of deps) visit(d);
  return out;
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function hasJavaSources(dir: string): Promise<boolean> {
  async function walk(current: string): Promise<boolean> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (await walk(full)) return true;
      } else if (entry.isFile() && entry.name.endsWith(".java")) {
        return true;
      }
    }
    return false;
  }
  try {
    return await walk(dir);
  } catch {
    return false;
  }
}
