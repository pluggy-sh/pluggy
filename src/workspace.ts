/**
 * Workspace discovery, inheritance, build-order graph, and scope
 * selection for workspace-aware commands.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import process from "node:process";

import { InvalidArgumentError } from "commander";

import { UserError } from "./errors.ts";
import type { Project, Registry, ResolvedProject } from "./project.ts";

const PROJECT_FILE_NAME = "project.json";

export interface WorkspaceNode {
  name: string;
  /** Absolute path to the workspace's root directory. */
  root: string;
  /** Merged project config (workspace's own fields + inherited fields from root). */
  project: ResolvedProject;
}

export interface WorkspaceContext {
  root: ResolvedProject;
  /** True when cwd resolves to the root `project.json` rather than to a workspace. */
  atRoot: boolean;
  /** The workspace cwd is inside, if any. Undefined when `atRoot`. */
  current?: WorkspaceNode;
  /** All declared workspaces in declaration order. Empty for standalone projects. */
  workspaces: WorkspaceNode[];
}

/**
 * Walk up from `cwd`, resolve the repo root, and classify which workspace
 * `cwd` sits in. Each workspace's `project.json` is merged with the root's
 * inheritable fields (see `mergeInheritance`). Returns `undefined` when
 * `cwd` is not inside any pluggy project.
 */
export function resolveWorkspaceContext(cwd: string): WorkspaceContext | undefined {
  const startDir = resolve(cwd);
  const nearest = findNearestProject(startDir);
  if (nearest === undefined) return undefined;

  if (Array.isArray(nearest.workspaces) && nearest.workspaces.length > 0) {
    const workspaces = enumerateWorkspaces(nearest);
    const current = findCurrentWorkspace(workspaces, startDir);
    return {
      root: nearest,
      atRoot: current === undefined,
      current,
      workspaces,
    };
  }

  // Nearest project has no workspaces; check whether a parent project lists it as one.
  const parentDir = dirname(nearest.rootDir);
  const parentProject = parentDir !== nearest.rootDir ? findNearestProject(parentDir) : undefined;

  if (
    parentProject !== undefined &&
    Array.isArray(parentProject.workspaces) &&
    parentProject.workspaces.some(
      (p) => resolveWorkspacePath(parentProject.rootDir, p) === nearest.rootDir,
    )
  ) {
    const workspaces = enumerateWorkspaces(parentProject);
    const current =
      findCurrentWorkspace(workspaces, startDir) ??
      workspaces.find((w) => w.root === nearest.rootDir);
    return {
      root: parentProject,
      atRoot: false,
      current,
      workspaces,
    };
  }

  return {
    root: nearest,
    atRoot: true,
    current: undefined,
    workspaces: [],
  };
}

/**
 * Topologically order workspaces by their `workspace:` inter-dependencies,
 * producing a build order where each node follows every node it depends on.
 * Throws on cycles. Unknown workspace deps are ignored (the resolver reports).
 */
export function topologicalOrder(workspaces: WorkspaceNode[]): WorkspaceNode[] {
  const byName = new Map<string, WorkspaceNode>();
  for (const ws of workspaces) {
    byName.set(ws.name, ws);
  }

  const result: WorkspaceNode[] = [];
  const state = new Map<string, "visiting" | "done">();

  const visit = (node: WorkspaceNode, stack: string[]): void => {
    const current = state.get(node.name);
    if (current === "done") return;
    if (current === "visiting") {
      const cyclePath = [...stack.slice(stack.indexOf(node.name)), node.name];
      const cycle = cyclePath.join(" -> ");
      throw new UserError(`workspace dependency cycle detected: ${cycle}`, {
        code: "E_WORKSPACE_CYCLE",
        hint: 'Break the cycle by removing one of the "workspace:" dependencies in this loop.',
        context: { cycle: cyclePath },
      });
    }

    state.set(node.name, "visiting");
    const deps = workspaceDependencyNames(node);
    for (const depName of deps) {
      const dep = byName.get(depName);
      if (dep === undefined) continue;
      visit(dep, [...stack, node.name]);
    }
    state.set(node.name, "done");
    result.push(node);
  };

  for (const ws of workspaces) {
    visit(ws, []);
  }
  return result;
}

/** Look up a workspace by name within a context. Throws if not found. */
export function findWorkspace(context: WorkspaceContext, name: string): WorkspaceNode {
  const hit = context.workspaces.find((w) => w.name === name);
  if (hit !== undefined) return hit;
  const known = context.workspaces.map((w) => w.name);
  const list = known.length > 0 ? known.join(", ") : "(none)";
  throw new UserError(`workspace not found: "${name}". known workspaces: ${list}`, {
    code: "E_WORKSPACE_NOT_FOUND",
    hint:
      known.length > 0
        ? `Known workspaces: ${known.join(", ")}`
        : "This project declares no workspaces.",
    context: { name, known },
  });
}

// ---------------------------------------------------------------------------
// Scope selection for workspace-aware commands
// ---------------------------------------------------------------------------

export interface ScopeOptions {
  cwd?: string;
  workspace?: string;
  workspaces?: boolean;
  /**
   * Refuse to implicitly span all workspaces at a root. `remove` sets this:
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
 * represents. The `name` is always meaningful as a human label, e.g.
 * for lockfile `declaredBy` or per-target output, regardless of source.
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
 * Resolve which workspaces a command should act on, from cwd plus per-command
 * flags. Throws `InvalidArgumentError` for user-input problems (no project,
 * unknown workspace name, ambiguous root scope).
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
        `${opts.commandName}: at the workspace root. Pass --workspace <name> or --workspaces to disambiguate`,
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

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function findNearestProject(start: string): ResolvedProject | undefined {
  let current = start;
  while (true) {
    const candidate = join(current, PROJECT_FILE_NAME);
    if (existsSync(candidate)) {
      return readProjectFile(candidate);
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function readProjectFile(projectFile: string): ResolvedProject {
  const raw = readFileSync(projectFile, "utf8");
  const parsed = JSON.parse(raw) as Project;
  return {
    ...parsed,
    rootDir: dirname(projectFile),
    projectFile,
  };
}

function resolveWorkspacePath(rootDir: string, rel: string): string {
  const normalized = rel.replace(/\\/g, "/");
  if (isAbsolute(normalized)) return resolve(normalized);
  return resolve(rootDir, normalized);
}

function enumerateWorkspaces(root: ResolvedProject): WorkspaceNode[] {
  const declared = root.workspaces ?? [];
  const nodes: WorkspaceNode[] = [];
  for (const rel of declared) {
    const wsDir = resolveWorkspacePath(root.rootDir, rel);
    const projectFile = join(wsDir, PROJECT_FILE_NAME);
    if (!existsSync(projectFile)) {
      throw new UserError(
        `workspace declared in ${root.projectFile} is missing project.json: ${wsDir}`,
        {
          code: "E_WORKSPACE_MISSING_PROJECT_JSON",
          hint: `Create ${projectFile} or remove the entry from "workspaces" in ${root.projectFile}.`,
          source: { file: root.projectFile, pointer: "/workspaces" },
          context: { workspaceDir: wsDir, expected: projectFile },
        },
      );
    }
    const raw = readFileSync(projectFile, "utf8");
    const own = JSON.parse(raw) as Project;
    const merged = mergeInheritance(root, own);
    const resolved: ResolvedProject = {
      ...merged,
      rootDir: wsDir,
      projectFile,
    };
    nodes.push({ name: resolved.name, root: wsDir, project: resolved });
  }
  return nodes;
}

/**
 * Merge root fields into a workspace project: `compatibility`, `authors`,
 * `description` inherit from the root when the workspace hasn't declared
 * them; `registries` are merged (root first, de-duped by URL); everything
 * else (including `version`) stays workspace-local.
 */
function mergeInheritance(root: ResolvedProject, own: Project): Project {
  const merged: Project = { ...own };

  if (own.compatibility === undefined || own.compatibility === null) {
    merged.compatibility = root.compatibility;
  }
  if (own.authors === undefined) {
    merged.authors = root.authors;
  }
  if (own.description === undefined) {
    merged.description = root.description;
  }
  merged.registries = mergeRegistries(root.registries, own.registries);

  return merged;
}

function mergeRegistries(
  rootRegs: (string | Registry)[] | undefined,
  wsRegs: (string | Registry)[] | undefined,
): (string | Registry)[] | undefined {
  if (rootRegs === undefined && wsRegs === undefined) return undefined;
  const out: (string | Registry)[] = [];
  const seen = new Set<string>();
  const push = (entry: string | Registry): void => {
    const url = typeof entry === "string" ? entry : entry.url;
    if (seen.has(url)) return;
    seen.add(url);
    out.push(entry);
  };
  for (const entry of rootRegs ?? []) push(entry);
  for (const entry of wsRegs ?? []) push(entry);
  return out;
}

/** Prefix-match cwd against each workspace root; longest prefix wins when nested. */
function findCurrentWorkspace(workspaces: WorkspaceNode[], cwd: string): WorkspaceNode | undefined {
  let best: WorkspaceNode | undefined;
  for (const ws of workspaces) {
    if (cwd === ws.root || cwd.startsWith(ws.root + "/") || cwd.startsWith(ws.root + "\\")) {
      if (best === undefined || ws.root.length > best.root.length) {
        best = ws;
      }
    }
  }
  return best;
}

function workspaceDependencyNames(node: WorkspaceNode): string[] {
  const deps = node.project.dependencies;
  if (deps === undefined) return [];
  const names: string[] = [];
  for (const value of Object.values(deps)) {
    // Short-form dependency values are Modrinth-version shorthand, not source strings.
    if (typeof value === "string") continue;
    const source = value.source;
    if (source.startsWith("workspace:")) {
      const name = source.slice("workspace:".length);
      if (name.length > 0) names.push(name);
    }
  }
  return names;
}
