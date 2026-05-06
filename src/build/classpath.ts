/**
 * Shared classpath resolution. `build`, `checkPlatformCompile`, and `docs`
 * all need the same answer to "what jars should be on the classpath for this
 * project?" — declared dependencies (with their transitive trees) plus the
 * platform API jars for the primary (or explicitly requested) platform.
 */

import { readLock, type LockfileEntry } from "../lockfile.ts";
import { getPlatform } from "../platform/index.ts";
import type { ResolvedProject } from "../project.ts";
import { effectiveRegistries } from "../registry.ts";
import { resolveDependency, type ResolvedDependency } from "../resolver/index.ts";
import { resolveMaven } from "../resolver/maven.ts";
import { parseSource, stringifySource } from "../source.ts";

export interface ResolveClasspathOptions {
  /**
   * Platform id whose API jars to resolve. Defaults to the first entry of
   * `project.compatibility.platforms`. `checkPlatformCompile` overrides this
   * to validate non-primary platforms.
   */
  platformId?: string;
}

export interface ProjectClasspath {
  /** Resolved declared dependencies, each with its transitive tree intact. */
  deps: ResolvedDependency[];
  /** Flattened, deduplicated platform API jars (already in classpath order). */
  platformApiJars: string[];
  /**
   * Final classpath: every declared dep jar (flattened from the transitive
   * trees) followed by `platformApiJars`, with order-preserving dedupe.
   */
  classpath: string[];
}

/**
 * Resolve the full classpath for `project`. Pulls the effective registry
 * list off the project (declared entries with aliases expanded, plus the
 * default Maven registries), resolves declared `dependencies` through the
 * same source-aware resolver `install` uses, and prepends platform API
 * repositories to the registry list when fetching the platform jars (so
 * user overrides still work but the platform's canonical repos are tried
 * first).
 */
export async function resolveProjectClasspath(
  project: ResolvedProject,
  opts: ResolveClasspathOptions = {},
): Promise<ProjectClasspath> {
  const registries = effectiveRegistries(project.registries);

  const [deps, platformApiJars] = await Promise.all([
    resolveDeclaredDependencies(project, registries),
    resolvePlatformApiJars(project, registries, opts.platformId),
  ]);

  const depJars = deps.flatMap(flattenJarPaths);
  const classpath = dedupePreservingOrder([...depJars, ...platformApiJars]);

  return { deps, platformApiJars, classpath };
}

/** Flatten `dep.jarPath` plus every transitive's jarPath into a single list. */
export function flattenJarPaths(dep: ResolvedDependency): string[] {
  const out: string[] = [dep.jarPath];
  for (const t of dep.transitiveDeps) {
    out.push(...flattenJarPaths(t));
  }
  return out;
}

async function resolveDeclaredDependencies(
  project: ResolvedProject,
  registries: string[],
): Promise<ResolvedDependency[]> {
  const deps = project.dependencies;
  if (deps === undefined || deps === null) return [];

  // Pull the lockfile entries up front so we can pass each top-level dep's
  // recorded `integrity` as `expectedIntegrity`. Catches the silent
  // upstream substitution scenario (registry rolls forward bytes for a
  // pinned version between `install` and `build`) — without this thread,
  // build re-resolved fresh and accepted whatever bytes came back.
  const lockEntries = readLock(project.rootDir)?.entries ?? {};

  const results: ResolvedDependency[] = [];
  for (const [name, raw] of Object.entries(deps)) {
    const { source, version } =
      typeof raw === "string"
        ? { source: `modrinth:${name}`, version: raw }
        : { source: raw.source, version: raw.version };
    const parsed = parseSource(source, version);
    const expectedIntegrity = expectedIntegrityFor(name, parsed, lockEntries);
    const resolved = await resolveDependency(parsed, {
      rootDir: project.rootDir,
      includePrerelease: false,
      force: false,
      registries,
      expectedIntegrity,
    });
    results.push(resolved);
  }
  return results;
}

/**
 * Look up the lockfile entry for `name` and return its `integrity` if the
 * recorded source/version still matches the declared one. Drift means the
 * pin is stale (user edited project.json since `install`) and the recorded
 * hash is no longer the right thing to enforce — surface the issue via
 * `pluggy install` rather than blocking the build.
 */
function expectedIntegrityFor(
  name: string,
  declaredSource: ReturnType<typeof parseSource>,
  lockEntries: Record<string, LockfileEntry>,
): string | undefined {
  const entry = lockEntries[name];
  if (entry === undefined) return undefined;
  if (stringifySource(entry.source) !== stringifySource(declaredSource)) return undefined;
  if (entry.source.version !== declaredSource.version) return undefined;
  return entry.integrity;
}

async function resolvePlatformApiJars(
  project: ResolvedProject,
  projectRegistries: string[],
  platformId: string | undefined,
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
    // pickDescriptor / build callers already surfaced this; stay quiet.
    return [];
  }

  const apiSpec = await primary.api(primaryVersion);
  if (apiSpec.dependencies.length === 0) return [];

  // Prefer the platform's own repos; project registries come after so user
  // overrides still work.
  const registries = dedupePreservingOrder([...apiSpec.repositories, ...projectRegistries]);

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
