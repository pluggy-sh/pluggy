/**
 * Test pipeline — resolve deps → compile src → compile test → run JUnit
 * Platform Console Launcher → parse JUnit XML reports. Orchestration only;
 * pure arg-building and report-parsing live in `./runner.ts`.
 *
 * JUnit Platform Console Standalone is auto-injected from Maven Central; the
 * user never declares it. User-provided test deps go in `project.json`'s
 * `testDependencies`, resolved through the same pipeline as `dependencies`.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { compileJava } from "../build/compile.ts";
import { log } from "../logging.ts";
import { getPlatform } from "../platform/index.ts";
import type { ResolvedProject } from "../project.ts";
import { resolveDependency, type ResolvedDependency } from "../resolver/index.ts";
import { resolveMaven } from "../resolver/maven.ts";
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

  const mainClassesDir = join(stagingDir, "main-classes");
  const testClassesDir = join(stagingDir, "test-classes");
  const reportsDir = join(stagingDir, "reports");

  await mkdir(mainClassesDir, { recursive: true });
  await mkdir(testClassesDir, { recursive: true });
  // Wipe reports per-run so a stale TEST-*.xml from a deleted class can't leak in.
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
  const mainClasspath = dedupe([...flattenJars(mainDeps), ...platformApiJars]);

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

  const testCompileClasspath = dedupe([
    mainClassesDir,
    ...mainClasspath,
    ...flattenJars(testDeps),
    junit.jarPath,
  ]);

  await compileJava(project, {
    sourceDir: join(project.rootDir, "src"),
    outputDir: mainClassesDir,
    classpath: mainClasspath,
  });

  await compileJava(project, {
    sourceDir: testSourceDir,
    outputDir: testClassesDir,
    classpath: testCompileClasspath,
  });

  const launcherArgs = buildLauncherArgs({
    consoleJar: junit.jarPath,
    classpath: [testClassesDir, ...testCompileClasspath],
    testClassesDir,
    reportsDir,
    filter: opts.filter,
    failFast: opts.failFast,
  });

  const { exitCode, stderrTail } = await runJavaLauncher(launcherArgs);

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

async function runJavaLauncher(args: string[]): Promise<{ exitCode: number; stderrTail: string }> {
  log.debug(`java ${args.length} args (JUnit Console Launcher)`);
  // We render our own output from the XML reports afterwards, so the launcher's
  // own stdout/stderr are suppressed. stderr is still buffered so we can attach
  // the tail to an error message on an unexpected launcher failure.
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("java", args, { stdio: ["ignore", "pipe", "pipe"] });
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

async function resolveDeclared(
  project: ResolvedProject,
  field: "dependencies" | "testDependencies",
  registries: string[],
): Promise<ResolvedDependency[]> {
  const declared = project[field];
  if (declared === undefined || declared === null) return [];

  const out: ResolvedDependency[] = [];
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
    out.push(resolved);
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
