/**
 * Build pipeline — compile → resources → descriptor → shade → jar.
 * Workspace orchestration is the caller's job; `buildProject` handles
 * exactly one workspace per call.
 */

import { createHash } from "node:crypto";
import { mkdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import { log } from "../logging.ts";
import { getPlatform } from "../platform/index.ts";
import { writeFileLF } from "../portable.ts";
import type { ResolvedProject } from "../project.ts";
import { parseSource } from "../source.ts";
import { resolveDependency, type ResolvedDependency } from "../resolver/index.ts";
import { resolveMaven } from "../resolver/maven.ts";

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
  /** Skip `.classpath` regeneration. */
  skipClasspath?: boolean;
}

export interface BuildResult {
  outputPath: string;
  sizeBytes: number;
  durationMs: number;
}

const STAGING_ROOT = ".pluggy-build";

/**
 * Drive the full build pipeline for one project. Returns the output jar
 * path, its size, and wall-clock duration. Throws on any stage failure —
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

  const descriptor = pickDescriptor(project);

  const outputPath =
    opts.output ?? join(project.rootDir, "bin", `${project.name}-${project.version}.jar`);

  const stagingId = createHash("sha256")
    .update(`${project.name}\0${project.version}\0${project.rootDir}`)
    .digest("hex")
    .slice(0, 12);
  const stagingDir = join(project.rootDir, STAGING_ROOT, stagingId);

  if (opts.clean) {
    await rm(stagingDir, { recursive: true, force: true });
  }
  await mkdir(stagingDir, { recursive: true });

  const registries = collectRegistries(project);
  const resolvedDeps = await resolveDeclaredDependencies(project, registries);
  const platformApiJars = await resolvePlatformApiJars(project, registries);

  const depJars = resolvedDeps.flatMap(flattenJarPaths);
  const classpath = dedupePreservingOrder([...depJars, ...platformApiJars]);

  if (!opts.skipClasspath) {
    try {
      await writeIdeFiles(project, classpath, stagingDir);
    } catch (err) {
      log.debug(`build: IDE scaffolding failed (non-fatal): ${(err as Error).message}`);
    }
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
  });

  await applyShading(resolvedDeps, project.shading ?? {}, stagingDir);

  await mkdir(dirname(outputPath), { recursive: true });
  await zipDirectory(stagingDir, outputPath);

  const info = await stat(outputPath);

  log.debug(`build: wrote ${outputPath} (${info.size} bytes)`);

  return {
    outputPath,
    sizeBytes: info.size,
    durationMs: Date.now() - started,
  };
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

  const registries = collectRegistries(project);
  const resolvedDeps = await resolveDeclaredDependencies(project, registries);
  const platformApiJars = await resolvePlatformApiJars(project, registries, platformId);

  const depJars = resolvedDeps.flatMap(flattenJarPaths);
  const classpath = dedupePreservingOrder([...depJars, ...platformApiJars]);

  await compileJava(project, {
    sourceDir: join(project.rootDir, "src"),
    outputDir: stagingDir,
    classpath,
  });
}

function hasUserDescriptor(project: ResolvedProject, descriptorPath: string): boolean {
  const resources = project.resources;
  if (resources === undefined || resources === null) return false;
  return Object.prototype.hasOwnProperty.call(resources, descriptorPath);
}

function collectRegistries(project: ResolvedProject): string[] {
  const out: string[] = [];
  for (const entry of project.registries ?? []) {
    out.push(typeof entry === "string" ? entry : entry.url);
  }
  return out;
}

async function resolveDeclaredDependencies(
  project: ResolvedProject,
  registries: string[],
): Promise<ResolvedDependency[]> {
  const deps = project.dependencies;
  if (deps === undefined || deps === null) return [];

  const results: ResolvedDependency[] = [];
  for (const [name, raw] of Object.entries(deps)) {
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
    results.push(resolved);
  }
  return results;
}

async function resolvePlatformApiJars(
  project: ResolvedProject,
  projectRegistries: string[],
  platformId?: string,
): Promise<string[]> {
  const platforms = project.compatibility?.platforms ?? [];
  const versions = project.compatibility?.versions ?? [];
  if (platforms.length === 0 || versions.length === 0) return [];

  const primaryId = platformId ?? platforms[0];
  const primaryVersion = versions[0];

  let primary;
  try {
    primary = getPlatform(primaryId);
  } catch {
    // pickDescriptor already surfaced this; stay quiet.
    return [];
  }

  const apiSpec = await primary.api(primaryVersion);
  if (apiSpec.dependencies.length === 0) return [];

  // Prefer the platform's own repos; project registries come after so user
  // overrides still work. Order-preserving dedup.
  const registries = uniqueInOrder([...apiSpec.repositories, ...projectRegistries]);

  const jars: string[] = [];
  for (const coord of apiSpec.dependencies) {
    const resolved = await resolveMaven(coord.groupId, coord.artifactId, coord.version, {
      rootDir: project.rootDir,
      includePrerelease: false,
      force: false,
      registries,
    });
    jars.push(...flattenJarPaths(resolved));
  }
  return dedupePreservingOrder(jars);
}

/** Flatten `dep.jarPath` plus every transitive's jarPath into a single list. */
function flattenJarPaths(dep: ResolvedDependency): string[] {
  const out: string[] = [dep.jarPath];
  for (const t of dep.transitiveDeps) {
    out.push(...flattenJarPaths(t));
  }
  return out;
}

function dedupePreservingOrder(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of paths) {
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

function uniqueInOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}
