/**
 * Resolve-context plumbing for `install` and `remove`. Workspace scope
 * selection lives in `src/workspace.ts`.
 */

import { DEFAULT_MAVEN_REGISTRIES, registryUrl } from "../registry.ts";
import type { ResolveContext } from "../resolver/index.ts";
import type { ScopeTarget, WorkspaceContext } from "../workspace.ts";

/**
 * Build a `ResolveContext` for `resolveDependency`. Unions registries from
 * the root and every workspace so the resolver sees every declared source,
 * regardless of which workspace declared it.
 */
export function buildResolveContext(
  context: WorkspaceContext,
  flags: { beta?: boolean; force?: boolean } = {},
): ResolveContext {
  const registries: string[] = [];
  const seen = new Set<string>();
  const push = (url: string): void => {
    const key = url.endsWith("/") ? url.slice(0, -1) : url;
    if (seen.has(key)) return;
    seen.add(key);
    registries.push(url);
  };
  for (const r of context.root.registries ?? []) push(registryUrl(r));
  for (const ws of context.workspaces) {
    for (const r of ws.project.registries ?? []) push(registryUrl(r));
  }
  for (const url of DEFAULT_MAVEN_REGISTRIES) push(url);

  return {
    rootDir: context.root.rootDir,
    includePrerelease: flags.beta === true,
    force: flags.force === true,
    registries,
    workspaceContext: context,
  };
}

/**
 * Enumerate every declared dependency across a list of targets. Returns one
 * entry per `(targetName, depName)` pair so callers can build `declaredBy`.
 */
export function collectDeclared(targets: ScopeTarget[]): Array<{
  declaredBy: string;
  name: string;
  value: string | { source: string; version: string };
}> {
  const out: Array<{
    declaredBy: string;
    name: string;
    value: string | { source: string; version: string };
  }> = [];
  for (const target of targets) {
    const deps = target.project.dependencies ?? {};
    for (const name of Object.keys(deps)) {
      const value = deps[name];
      if (value === undefined) continue;
      out.push({ declaredBy: target.name, name, value });
    }
  }
  return out;
}

/**
 * Canonicalize a `DependencyValue` (sugar string or long form) into a
 * `(source, version)` pair. Sugar `"foo": "1.2.3"` expands to
 * `modrinth:<name>`.
 */
export function canonicalizeDeclared(
  name: string,
  value: string | { source: string; version: string },
): { source: string; version: string } {
  if (typeof value === "string") {
    return { source: `modrinth:${name}`, version: value };
  }
  return { source: value.source, version: value.version };
}
