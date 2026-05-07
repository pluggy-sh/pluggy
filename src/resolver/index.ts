/**
 * Dependency resolver — dispatches a `ResolvedSource` to its per-kind
 * resolver, which produces a `ResolvedDependency` (cached jar path plus
 * integrity hash).
 */

import type { ResolvedSource } from "../source.ts";
import type { WorkspaceContext } from "../workspace.ts";

import { resolveFile } from "./file.ts";
import { resolveMaven } from "./maven.ts";
import { resolveModrinth } from "./modrinth.ts";
import { resolveWorkspace } from "./workspace.ts";

export interface ResolvedDependency {
  source: ResolvedSource;
  /** Absolute path to the resolved jar in the user cache. */
  jarPath: string;
  /** SHA-256 of the jar as `"sha256-<hex>"`. */
  integrity: string;
  transitiveDeps: ResolvedDependency[];
}

export interface ResolveContext {
  /** Repo root (where `pluggy.lock` lives). Base for `file:` path resolution. */
  rootDir: string;
  /** Include pre-release versions when resolving from registries. */
  includePrerelease: boolean;
  /** Bypass compatibility checks. */
  force: boolean;
  /** Maven registries tried in order. Required for `maven:` sources. */
  registries: string[];
  /** Required for `workspace:` sources; resolving one without it throws. */
  workspaceContext?: WorkspaceContext;
  /**
   * Optional `sha256-<hex>` from the lockfile. When set, resolvers verify
   * the resolved bytes match it and refuse to overwrite with anything else.
   * Caller passes this only when it has a recorded integrity to enforce
   * (i.e. resolving an existing pinned dep, not a fresh install).
   */
  expectedIntegrity?: string;
}

/**
 * Dispatch a `ResolvedSource` to its per-kind resolver. Straight
 * pass-through — no retries, no fallbacks.
 */
export function resolveDependency(
  source: ResolvedSource,
  ctx: ResolveContext,
): Promise<ResolvedDependency> {
  switch (source.kind) {
    case "modrinth":
      return resolveModrinth(source.slug, source.version, ctx);
    case "maven":
      return resolveMaven(source.groupId, source.artifactId, source.version, ctx);
    case "file":
      return resolveFile(source.path, source.version, ctx);
    case "workspace":
      return resolveWorkspace(source.name, source.version, ctx);
  }
}
