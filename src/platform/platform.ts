/**
 * Platform registry. Providers self-register via `createPlatform`; callers
 * look one up by id with `getPlatform`.
 */

import type { ResolvedProject } from "../project.ts";

import { getCachePath } from "../project.ts";

/** Concrete version identifier: upstream version string + its build number. */
export interface Version {
  version: string;
  build: number;
}

/** Maven coordinates a platform exposes for downstream compilation. */
export interface MavenAPI {
  repositories: string[];
  dependencies: Array<{ groupId: string; artifactId: string; version: string }>;
}

/**
 * Family of plugin platforms that share a runtime API: bukkit-derivatives
 * (paper/folia/spigot/bukkit), velocity proxies, or bungee proxies. Used by
 * the scaffolder + template selector to pick a stub class that actually
 * compiles against the chosen platform.
 */
export type PlatformFamily = "bukkit" | "velocity" | "bungee";

/** How a plugin descriptor is serialized into the final jar. */
export interface DescriptorSpec {
  /** Path inside the final plugin jar where the descriptor is written. */
  path: string;
  format: "yaml" | "json" | "toml";
  /** Family this descriptor belongs to — drives stub-class selection. */
  family: PlatformFamily;
  generate(project: ResolvedProject): string;
}

/** Contract each platform (paper, spigot, ...) implements. */
export interface PlatformProvider {
  id: string;
  descriptor: DescriptorSpec;

  getVersions(): Promise<string[]>;
  getLatestVersion(): Promise<Version>;
  getVersionInfo(version: string): Promise<Version>;

  /** Fetch (or retrieve from cache) the platform server jar. */
  download(version: Version, ignoreCache: boolean): Promise<Version & { output: Uint8Array }>;

  api(version: string): Promise<MavenAPI>;
}

/** Everything a provider factory is allowed to read from the runtime. */
export interface PlatformContext {
  getCachePath(): string;
}

const PLATFORMS: Record<string, PlatformProvider> = {};

/**
 * Define and register a platform provider. The factory runs at module-load
 * time and must not perform I/O — the Bun-compiled binary ships a read-only
 * `$bunfs` and would crash on disk writes before command dispatch.
 */
export function createPlatform<T extends PlatformProvider>(
  provider: (context: PlatformContext) => T,
): T {
  const platform = provider({ getCachePath });
  PLATFORMS[platform.id.toLowerCase()] = platform;
  return platform;
}

/** Look up a registered platform by id (case-insensitive). Throws if missing. */
export function getPlatform(providerId: string): PlatformProvider {
  const id = providerId.toLowerCase();
  if (!PLATFORMS[id]) throw new Error(`Platform with id '${providerId}' not found`);
  return PLATFORMS[id];
}

/** List every registered platform id, lowercased. */
export function getRegisteredPlatforms(): string[] {
  return Object.keys(PLATFORMS);
}

/**
 * Validate that every id in `platformIds` resolves to a registered platform
 * and that they all share one `descriptor.family`. Returns that shared family.
 *
 * A plugin can only target one family at a time — bukkit-derived APIs and
 * proxy APIs (velocity, bungee) don't share an entry-point class. Mixing
 * them in `compatibility.platforms` is always a project-config bug.
 */
export function assertSamePlatformFamily(platformIds: string[]): PlatformFamily {
  if (platformIds.length === 0) {
    throw new Error("compatibility.platforms is empty — at least one platform is required.");
  }

  const byFamily = new Map<PlatformFamily, string[]>();
  for (const id of platformIds) {
    const family = getPlatform(id).descriptor.family;
    const list = byFamily.get(family) ?? [];
    list.push(id);
    byFamily.set(family, list);
  }

  if (byFamily.size > 1) {
    const groups = Array.from(byFamily.entries())
      .map(([family, ids]) => `${family} (${ids.join(", ")})`)
      .join(" vs ");
    throw new Error(
      `compatibility.platforms must share one family — got ${groups}. ` +
        "Split platforms from different families into separate workspaces.",
    );
  }

  return byFamily.keys().next().value as PlatformFamily;
}
