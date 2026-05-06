/**
 * Shared scope / ResolveContext helpers for `install` and `remove`.
 */

import process from "node:process";

import { InvalidArgumentError } from "commander";

import type { ResolvedProject } from "../project.ts";
import { DEFAULT_MAVEN_REGISTRIES, registryUrl } from "../registry.ts";
import type { ResolveContext } from "../resolver/index.ts";
import type { WorkspaceContext } from "../workspace.ts";
import { findWorkspace, resolveWorkspaceContext } from "../workspace.ts";

export interface ScopeOptions {
  cwd?: string;
  workspace?: string;
  workspaces?: boolean;
  /**
   * Refuse to implicitly span all workspaces at a root. `remove` sets this —
   * running at the root without an explicit flag is ambiguous. `install`
   * leaves it false (at-root default is "all workspaces").
   */
  requireExplicitAtRoot?: boolean;
  /** Command name interpolated into error messages. */
  commandName: string;
}

/**
 * One target for a workspace-aware command. `name` and `project` come from
 * either a workspace node or the standalone-project root depending on the
 * scope:
 *   - In a workspace context: workspace name + workspace project.
 *   - In a standalone context: root project name + root project.
 *
 * Use `ResolvedScope.spansAllWorkspaces` to tell which form a target list
 * represents. The `name` is always meaningful as a human label (e.g. for
 * lockfile `declaredBy` or per-target output) regardless of source.
 */
export interface ScopeTarget {
  name: string;
  project: ResolvedProject;
}

export interface ResolvedScope {
  context: WorkspaceContext;
  targets: ScopeTarget[];
  /** True when acting across every workspace (implicit at-root or `--workspaces`). */
  spansAllWorkspaces: boolean;
}

/**
 * Resolve the workspace scope from cwd + per-command flags. Throws
 * `InvalidArgumentError` for user-input problems (no project, unknown
 * workspace name, ambiguous root scope).
 */
export function resolveScope(opts: ScopeOptions): ResolvedScope {
  const cwd = opts.cwd ?? process.cwd();
  const context = resolveWorkspaceContext(cwd);
  if (context === undefined) {
    throw new InvalidArgumentError(
      `${opts.commandName}: no pluggy project found at or above "${cwd}"`,
    );
  }

  if (opts.workspace !== undefined) {
    if (context.workspaces.length === 0) {
      throw new InvalidArgumentError(
        `${opts.commandName}: --workspace "${opts.workspace}" was given but this project has no workspaces`,
      );
    }
    const node = findWorkspace(context, opts.workspace);
    return {
      context,
      targets: [{ name: node.name, project: node.project }],
      spansAllWorkspaces: false,
    };
  }

  if (opts.workspaces === true) {
    if (context.workspaces.length === 0) {
      throw new InvalidArgumentError(
        `${opts.commandName}: --workspaces was given but this project has no workspaces`,
      );
    }
    return {
      context,
      targets: context.workspaces.map((w) => ({ name: w.name, project: w.project })),
      spansAllWorkspaces: true,
    };
  }

  if (context.current !== undefined) {
    return {
      context,
      targets: [{ name: context.current.name, project: context.current.project }],
      spansAllWorkspaces: false,
    };
  }

  if (context.workspaces.length > 0) {
    if (opts.requireExplicitAtRoot === true) {
      throw new InvalidArgumentError(
        `${opts.commandName}: at the workspace root — pass --workspace <name> or --workspaces to disambiguate`,
      );
    }
    return {
      context,
      targets: context.workspaces.map((w) => ({ name: w.name, project: w.project })),
      spansAllWorkspaces: true,
    };
  }

  return {
    context,
    targets: [{ name: context.root.name, project: context.root }],
    spansAllWorkspaces: false,
  };
}

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
 * Canonicalize a `DependencyValue` — sugar string or long form — into a
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
