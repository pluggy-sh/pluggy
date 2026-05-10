/**
 * Workspace-sibling resolver. Points at where the named sibling's built jar
 * _would_ live (`<workspace.root>/bin/<name>-<version>.jar`); the build
 * pipeline is responsible for producing it. Until then the integrity is a
 * sentinel string (`PENDING_BUILD_INTEGRITY`) downstream consumers detect.
 */

import { join } from "node:path";

import { findWorkspace } from "../workspace.ts";
import type { ResolvedSource } from "../source.ts";

import type { ResolveContext, ResolvedDependency } from "./index.ts";

/** Sentinel integrity value returned before the sibling has been built. */
export const PENDING_BUILD_INTEGRITY = "sha256-pending-build";

/**
 * Resolve a `workspace:<name>` source against the current workspace context.
 * Requires `ctx.workspaceContext` to be set; throws if missing or if the
 * named sibling is not declared.
 */
export function resolveWorkspace(
  name: string,
  version: string,
  ctx: ResolveContext,
): Promise<ResolvedDependency> {
  if (ctx.workspaceContext === undefined) {
    return Promise.reject(
      new Error(
        `workspace sources require a WorkspaceContext (workspace "${name}" cannot be resolved without one)`,
      ),
    );
  }

  let ws;
  try {
    ws = findWorkspace(ctx.workspaceContext, name);
  } catch (err) {
    return Promise.reject(err as Error);
  }

  // The jar path is derived from a concrete version. The dep's declared
  // version (often "*") is too loose to use as a filename, so the workspace
  // must declare its own. Throw early with a clear pointer rather than emit
  // a path like `bin/api-*.jar` that won't match anything build produces.
  const concreteVersion =
    ws.project.version !== undefined ? ws.project.version : version !== "*" ? version : undefined;
  if (concreteVersion === undefined) {
    return Promise.reject(
      new Error(
        `workspace "${name}" has no concrete version: set "version" in ${ws.project.projectFile} so its built jar has a stable filename`,
      ),
    );
  }

  const jarPath = join(ws.root, "bin", `${ws.name}-${concreteVersion}.jar`);

  const source: ResolvedSource = {
    kind: "workspace",
    name,
    version: concreteVersion,
  };

  return Promise.resolve({
    source,
    jarPath,
    integrity: PENDING_BUILD_INTEGRITY,
    transitiveDeps: [],
  });
}
