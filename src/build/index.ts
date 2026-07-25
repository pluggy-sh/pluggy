/**
 * Build pipeline: compile → resources → descriptor → shade → jar.
 * Workspace orchestration is the caller's job; `buildProject` handles
 * exactly one workspace per call.
 */

import { createHash } from "node:crypto";
import { mkdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import { log } from "../logging.ts";
import { writeFileLF } from "../portable.ts";
import type { ResolvedProject } from "../project.ts";
import { ensureJdkForProject } from "../sdk/index.ts";

import { resolveProjectClasspath } from "./classpath.ts";
import { compileJava } from "./compile.ts";
import { pickDescriptor } from "./descriptor.ts";
import { writeIdeFiles } from "./ide.ts";
import { zipDirectory } from "./jar.ts";
import { stageResources } from "./resources.ts";
import { applyShading } from "./shade.ts";

export interface BuildOptions {
  /** Output jar path. Default: `./bin/<name>-<version>.jar` in the workspace. */
  output?: string;
  /** Wipe build cache before building. */
  clean?: boolean;
  /**
   * Exploded staging directory to build in. Defaults to the deterministic
   * `projectStagingDir`. The dev runtime overrides this with a session-private
   * dir so a concurrent `pluggy build` (or an IDE build task) can't clear or
   * repopulate the tree mid-build and yield a jar missing its `.class` files.
   */
  stagingDir?: string;
  /**
   * Extra files to drop into the staging directory before zipping. Map keys
   * are relative paths inside the JAR; values are file contents (LF-only).
   */
  extraStagingFiles?: Record<string, string>;
}

export interface BuildResult {
  outputPath: string;
  sizeBytes: number;
  durationMs: number;
  /**
   * Absolute path to the exploded class/resource staging directory. The dev
   * agent redefines classes straight from here, so a hotswap only needs the
   * `.class` files in this dir refreshed — not a full jar.
   */
  stagingDir: string;
  /**
   * The resolved compile classpath and `javac` path. The dev loop caches these
   * from the first build so hotswap recompiles skip re-resolving dependencies
   * (which can hit the network) — see `recompileClasses`.
   */
  classpath: string[];
  javacPath: string;
}

const STAGING_ROOT = ".pluggy-build";

/** The staging directory `buildProject` uses for `project`, without building. */
export function projectStagingDir(project: ResolvedProject): string {
  const stagingId = createHash("sha256")
    .update(`${project.name}\0${project.version}\0${project.rootDir}`)
    .digest("hex")
    .slice(0, 12);
  return join(project.rootDir, STAGING_ROOT, stagingId);
}

/**
 * Session-private staging dir for `pluggy dev`. Distinct from
 * `projectStagingDir` so a concurrent `pluggy build` or IDE build task never
 * shares the tree the dev server's agent redefines from.
 */
export function devStagingDir(project: ResolvedProject): string {
  return `${projectStagingDir(project)}-dev`;
}

/**
 * Drive the full build pipeline for one project. Returns the output jar
 * path, its size, and wall-clock duration. Throws on any stage failure;
 * partial output is left in the staging directory for inspection.
 *
 * The staging dir is keyed by a (name, version, rootDir) hash so repeat
 * builds reuse the same path and `--clean` reliably nukes it.
 */
export async function buildProject(
  project: ResolvedProject,
  opts: BuildOptions,
): Promise<BuildResult> {
  const started = Date.now();

  // Every buildable project is a plugin. Shared code can't be a bare library:
  // Java isolates each plugin's classloader, so shading the same classes into
  // two plugins duplicates them (and any static state). Shared code must be its
  // own plugin that others `depend` on. A missing `main` is therefore an error,
  // not a "library".
  if (project.main === undefined || project.main.length === 0) {
    throw new Error(
      `"${project.name}" has no \`main\`: every plugin needs an entry-point class. ` +
        `Shared code must be its own plugin that others depend on (a \`workspace:\` dep ` +
        `becomes a plugin.yml \`depend\`), not a library.`,
    );
  }

  const descriptor = pickDescriptor(project);

  const outputPath =
    opts.output ?? join(project.rootDir, "bin", `${project.name}-${project.version}.jar`);

  const stagingDir = opts.stagingDir ?? projectStagingDir(project);

  if (opts.clean) {
    await rm(stagingDir, { recursive: true, force: true });
  }
  await mkdir(stagingDir, { recursive: true });

  const [{ deps: resolvedDeps, classpath }, jdk] = await Promise.all([
    resolveProjectClasspath(project),
    ensureJdkForProject(project),
  ]);

  try {
    await writeIdeFiles(project, classpath, stagingDir);
  } catch (err) {
    log.debug(`build: IDE scaffolding failed (non-fatal): ${(err as Error).message}`);
  }

  await stageResources(project, stagingDir);

  // Auto-generate the descriptor unless the user staged one through `resources`.
  const descriptorRelPath = descriptor.path;
  if (!hasUserDescriptor(project, descriptorRelPath)) {
    const rendered = descriptor.generate(project);
    const destination = join(stagingDir, descriptorRelPath);
    await mkdir(dirname(destination), { recursive: true });
    await writeFileLF(destination, rendered);
  }

  await compileJava(project, {
    sourceDir: join(project.rootDir, "src"),
    outputDir: stagingDir,
    classpath,
    javacPath: jdk.javacPath,
  });

  await applyShading(resolvedDeps, project.shading ?? {}, stagingDir);

  for (const [relPath, contents] of Object.entries(opts.extraStagingFiles ?? {})) {
    const dest = join(stagingDir, relPath);
    await mkdir(dirname(dest), { recursive: true });
    await writeFileLF(dest, contents);
  }

  await mkdir(dirname(outputPath), { recursive: true });
  await zipDirectory(stagingDir, outputPath);

  const info = await stat(outputPath);

  log.debug(`build: wrote ${outputPath} (${info.size} bytes)`);

  return {
    outputPath,
    sizeBytes: info.size,
    durationMs: Date.now() - started,
    stagingDir,
    classpath,
    javacPath: jdk.javacPath,
  };
}

/**
 * Recompile `.java` into `stagingDir` and nothing else — no dependency
 * resolution, resource staging, shading, or jar. `classpath`/`javacPath` are
 * the cached values from a prior full build.
 */
export async function recompileClasses(
  project: ResolvedProject,
  opts: { classpath: string[]; javacPath: string; stagingDir: string },
): Promise<void> {
  await compileJava(project, {
    sourceDir: join(project.rootDir, "src"),
    outputDir: opts.stagingDir,
    classpath: opts.classpath,
    javacPath: opts.javacPath,
  });
}

/**
 * Compile the project against a specific platform's API without producing a
 * JAR. Used by multi-platform validation to check each declared platform
 * independently of the primary build.
 *
 * Throws with a javac error message on failure.
 */
export async function checkPlatformCompile(
  project: ResolvedProject,
  platformId: string,
  opts: Pick<BuildOptions, "clean"> = {},
): Promise<void> {
  const stagingId = createHash("sha256")
    .update(`${project.name}\0${project.version}\0${project.rootDir}\0${platformId}`)
    .digest("hex")
    .slice(0, 12);
  const stagingDir = join(project.rootDir, STAGING_ROOT, `${stagingId}-check`);

  if (opts.clean) await rm(stagingDir, { recursive: true, force: true });
  await mkdir(stagingDir, { recursive: true });

  const [{ classpath }, jdk] = await Promise.all([
    resolveProjectClasspath(project, { platformId }),
    ensureJdkForProject(project),
  ]);

  await compileJava(project, {
    sourceDir: join(project.rootDir, "src"),
    outputDir: stagingDir,
    classpath,
    javacPath: jdk.javacPath,
  });
}

function hasUserDescriptor(project: ResolvedProject, descriptorPath: string): boolean {
  const resources = project.resources;
  if (resources === undefined || resources === null) return false;
  return Object.prototype.hasOwnProperty.call(resources, descriptorPath);
}
