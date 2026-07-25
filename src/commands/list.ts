import process from "node:process";

import { Command, InvalidArgumentError } from "commander";

import { UserError } from "../errors.ts";
import { bold, dim, emit, log } from "../logging.ts";
import { type LockfileEntry, readLock } from "../lockfile.ts";
import type { Dependency, ResolvedProject } from "../project.ts";
import { DEFAULT_MAVEN_REGISTRIES, registryUrl } from "../registry.ts";
import { parseSource, type ResolvedSource } from "../source.ts";
import {
  findWorkspace,
  projectStartDir,
  resolveWorkspaceContext,
  singleWorkspace,
  workspaceListOption,
  type WorkspaceContext,
  type WorkspaceNode,
} from "../workspace.ts";

export interface ListOptions {
  tree?: boolean;
  workspace?: string;
  workspaces?: boolean;
  exclude?: string[];
  /** Global `--project <path>` flag: resolve the project from this file instead of cwd. */
  project?: string;
  cwd?: string;
}

export interface DepEntry {
  name: string;
  source: ResolvedSource;
  declaredVersion: string;
  resolvedVersion: string | null;
  integrity: string | null;
  declaredBy: string[];
  /**
   * Transitive children sourced from the lockfile. Populated recursively
   * for `--tree` rendering and for JSON output consumers. Leaf deps omit
   * the field entirely.
   */
  children?: DepEntry[];
}

export interface RegistryEntry {
  url: string;
  authenticated: boolean;
}

export interface ListResult {
  scope: "root" | "workspace" | "standalone";
  deps: DepEntry[];
  registries: RegistryEntry[];
  target: string;
}

/**
 * Enumerate declared dependencies and registries for the current scope.
 *
 * Aggregates per-workspace declarations by dep name (merging `declaredBy`
 * lists), overlays resolved versions from `pluggy.lock`, and elides registry
 * credentials. Credentials must never appear in the result; it feeds `--json`
 * output and terminal logs.
 */
export async function doList(options: ListOptions): Promise<ListResult> {
  const cwd = options.cwd ?? process.cwd();
  const ctx = resolveWorkspaceContext(projectStartDir(options.project, cwd));
  if (ctx === undefined) {
    throw new UserError("No pluggy project found. Run this from inside a project directory.", {
      code: "E_LIST_NO_PROJECT",
      hint: "Run `pluggy init` to create a new project, or cd into an existing one.",
    });
  }

  const scope = determineScope(ctx, options);
  const targets = selectTargets(ctx, options, scope);
  const lock = readLock(ctx.root.rootDir);

  const agg = new Map<string, DepEntry>();
  for (const { declaringName, project } of targets) {
    const deps = project.dependencies ?? {};
    for (const [name, rawValue] of Object.entries(deps)) {
      const source = normalizeDependencySource(name, rawValue);
      const declaredVersion = source.version;

      const lockEntry = lock?.entries[name];
      const resolvedVersion = lockEntry?.resolvedVersion ?? null;
      const integrity = lockEntry?.integrity ?? null;

      const existing = agg.get(name);
      if (existing) {
        if (!existing.declaredBy.includes(declaringName)) {
          existing.declaredBy.push(declaringName);
        }
      } else {
        const entry: DepEntry = {
          name,
          source,
          declaredVersion,
          resolvedVersion,
          integrity,
          declaredBy: [declaringName],
        };
        if (
          lock !== null &&
          lockEntry?.transitives !== undefined &&
          lockEntry.transitives.length > 0
        ) {
          const children = buildChildren(lock.entries, lockEntry.transitives, new Set([name]));
          if (children.length > 0) entry.children = children;
        }
        agg.set(name, entry);
      }
    }
  }

  let deps = Array.from(agg.values()).sort((a, b) => a.name.localeCompare(b.name));
  const registries = collectRegistries(ctx);

  const target =
    scope === "root"
      ? ctx.root.name
      : scope === "workspace"
        ? (options.workspace ?? ctx.current?.name ?? ctx.root.name)
        : ctx.root.name;

  const result: ListResult = { scope, deps, registries, target };

  emit({ status: "success", ...result }, () => {
    if (options.tree) {
      printTreeList(result);
    } else {
      printHumanList(result);
    }
  });

  return result;
}

function determineScope(
  ctx: WorkspaceContext,
  options: ListOptions,
): "root" | "workspace" | "standalone" {
  if (ctx.workspaces.length === 0) return "standalone";
  if (options.workspace !== undefined) return "workspace";
  if (options.workspaces) return "root";
  if (ctx.atRoot) return "root";
  return "workspace";
}

interface DepTarget {
  declaringName: string;
  project: ResolvedProject;
}

function selectTargets(
  ctx: WorkspaceContext,
  options: ListOptions,
  scope: "root" | "workspace" | "standalone",
): DepTarget[] {
  // `--exclude` subtracts from an all-workspaces view, so on any single-target
  // scope it cannot apply. Ignoring it made `--workspace shop --exclude core`
  // look honoured while the sweep commands rejected the same combination.
  const rejectUnusableExclude = (reason: string): void => {
    if ((options.exclude?.length ?? 0) === 0) return;
    throw new InvalidArgumentError(`list: --exclude ${reason}`);
  };

  if (scope === "standalone") {
    rejectUnusableExclude("given but this project declares no workspaces.");
    return [{ declaringName: ctx.root.name, project: ctx.root }];
  }
  if (scope === "workspace") {
    if (options.workspace !== undefined) {
      rejectUnusableExclude(
        "cannot be combined with --workspace; it subtracts from an all-workspaces run.",
      );
      const node = findWorkspace(ctx, options.workspace);
      return [{ declaringName: node.name, project: node.project }];
    }
    if (ctx.current) {
      rejectUnusableExclude(
        `is only valid with --workspaces or at the repo root; you're inside workspace "${ctx.current.name}".`,
      );
      return [{ declaringName: ctx.current.name, project: ctx.current.project }];
    }
  }
  const excluded = new Set((options.exclude ?? []).map((name) => findWorkspace(ctx, name).name));
  return ctx.workspaces
    .filter((w: WorkspaceNode) => !excluded.has(w.name))
    .map((w: WorkspaceNode) => ({
      declaringName: w.name,
      project: w.project,
    }));
}

/**
 * Build child `DepEntry`s by walking the flat lockfile graph forward from
 * a parent's `transitives` (an array of entry names). `seen` prevents
 * infinite recursion on a cyclic graph. A child whose name isn't present
 * in `entries` is skipped: the lockfile validator should never let that
 * through, but it would be wrong to crash list output if it did.
 *
 * `declaredVersion` has no meaningful value for a transitive; we reuse
 * `resolvedVersion` so consumers don't have to special-case a nullable
 * field.
 */
function buildChildren(
  entries: Record<string, LockfileEntry>,
  names: string[],
  seen: Set<string>,
): DepEntry[] {
  const out: DepEntry[] = [];
  for (const name of names) {
    if (seen.has(name)) continue;
    const entry = entries[name];
    if (entry === undefined) continue;
    const nextSeen = new Set(seen);
    nextSeen.add(name);
    const child: DepEntry = {
      name,
      source: entry.source,
      declaredVersion: entry.resolvedVersion,
      resolvedVersion: entry.resolvedVersion,
      integrity: entry.integrity,
      declaredBy: [],
    };
    if (entry.transitives !== undefined && entry.transitives.length > 0) {
      const grandchildren = buildChildren(entries, entry.transitives, nextSeen);
      if (grandchildren.length > 0) child.children = grandchildren;
    }
    out.push(child);
  }
  return out;
}

function normalizeDependencySource(name: string, raw: string | Dependency): ResolvedSource {
  // Short-form `"foo": "1.2.3"` is sugar for `modrinth:<name>`.
  if (typeof raw === "string") {
    return { kind: "modrinth", slug: name, version: raw };
  }
  return parseSource(raw.source, raw.version);
}

function collectRegistries(ctx: WorkspaceContext): RegistryEntry[] {
  const project = ctx.current?.project ?? ctx.root;
  const raw = project.registries ?? [];
  const out: RegistryEntry[] = [];
  const seen = new Set<string>();
  const push = (url: string, authenticated: boolean): void => {
    const key = url.endsWith("/") ? url.slice(0, -1) : url;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ url, authenticated });
  };
  for (const entry of raw) {
    const url = registryUrl(entry);
    const authenticated = typeof entry !== "string" && entry.credentials !== undefined;
    push(url, authenticated);
  }
  for (const url of DEFAULT_MAVEN_REGISTRIES) push(url, false);
  return out;
}

function printHumanList(result: ListResult): void {
  log.info(bold(`${result.scope}: ${result.target}`));
  const shown = result.deps;
  if (shown.length === 0) {
    log.info(dim("  (no dependencies declared)"));
  } else {
    log.info("");
    log.info(bold("dependencies:"));
    for (const dep of shown) {
      const resolved = dep.resolvedVersion ?? dim("(unresolved; run install)");
      const decl = result.scope === "root" ? ` ${dim(`[${dep.declaredBy.join(", ")}]`)}` : "";
      log.info(
        `  ${dep.name}  ${dim(`declared: ${dep.declaredVersion}`)}  ${dim(`resolved:`)} ${resolved}  ${dim(describeSource(dep.source))}${decl}`,
      );
    }
  }
  log.info("");
  log.info(bold("registries:"));
  if (result.registries.length === 0) {
    log.info(dim("  (none declared; Modrinth is implicit)"));
  } else {
    for (const reg of result.registries) {
      const auth = reg.authenticated ? dim(" [authenticated]") : "";
      log.info(`  ${reg.url}${auth}`);
    }
  }
}

/**
 * Render the dep list with tree-draw characters. Top-level deps render
 * with their transitive closure (if the lockfile tracks one) using the
 * same glyph conventions as `tree(1)`:
 *
 * - `├──` / `└──` mark the branch at the current level
 * - `│   ` / `    ` continue the indentation when descending
 *
 * `--outdated` applies to top-level entries only. Transitive outdated
 * checking is a future exercise (would require per-kind latest-version
 * queries through the closure; for now the semantics are: "show me my
 * declared deps that need updates", and transitives come along for the
 * ride when their parent is listed).
 */
function printTreeList(result: ListResult): void {
  log.info(bold(`${result.scope}: ${result.target}`));
  const shown = result.deps;
  if (shown.length === 0) {
    log.info(dim("  (no dependencies declared)"));
  } else {
    log.info("");
    log.info(bold("dependencies:"));
    for (let i = 0; i < shown.length; i++) {
      renderDepNode(shown[i], "  ", i === shown.length - 1);
    }
  }
  log.info("");
  log.info(bold("registries:"));
  if (result.registries.length === 0) {
    log.info(dim("  (none declared; Modrinth is implicit)"));
  } else {
    for (let i = 0; i < result.registries.length; i++) {
      const reg = result.registries[i];
      const last = i === result.registries.length - 1;
      const branch = last ? "└──" : "├──";
      const auth = reg.authenticated ? dim(" [authenticated]") : "";
      log.info(`  ${dim(branch)} ${reg.url}${auth}`);
    }
  }
}

/**
 * Render one node of the dep tree and recurse into its children. `prefix`
 * carries the cumulative indentation from ancestors (a mix of `│   ` for
 * open ancestors and `    ` for closed ones). `last` toggles the leaf
 * glyph.
 */
function renderDepNode(dep: DepEntry, prefix: string, last: boolean): void {
  const branch = last ? "└──" : "├──";
  const resolved = dep.resolvedVersion ?? dim("(unresolved)");
  log.info(
    `${prefix}${dim(branch)} ${dep.name}  ${dim(`@${dep.declaredVersion} → ${resolved}`)}  ${dim(describeSource(dep.source))}`,
  );
  const children = dep.children ?? [];
  if (children.length === 0) return;
  const childPrefix = `${prefix}${last ? "    " : "│   "}`;
  for (let i = 0; i < children.length; i++) {
    renderDepNode(children[i], childPrefix, i === children.length - 1);
  }
}

function describeSource(source: ResolvedSource): string {
  switch (source.kind) {
    case "modrinth":
      return `modrinth:${source.slug}`;
    case "maven":
      return `maven:${source.groupId}:${source.artifactId}`;
    case "file":
      return `file:${source.path}`;
    case "workspace":
      return `workspace:${source.name}`;
  }
}

/** Factory for the `pluggy list` commander command. */
export function listCommand(): Command {
  return new Command("list")
    .alias("ls")
    .description("List all installed plugins, dependencies and registries.")
    .option("--tree", "Render as dependency tree (with transitive deps).")
    .option("--workspace <names>", "Show a specific workspace.", workspaceListOption)
    .option("--workspaces", "Aggregated view across all workspaces.")
    .option(
      "--exclude <names>",
      "Exclude workspaces from an all-workspaces list (repeatable; comma-separated).",
      workspaceListOption,
    )
    .action(async function action(this: Command, options) {
      const globalOpts = this.optsWithGlobals();
      await doList({
        tree: options.tree,
        workspace: singleWorkspace(
          options.workspace as string[] | undefined,
          "list",
          "Use --workspaces for the aggregated view.",
        ),
        workspaces: options.workspaces,
        exclude: options.exclude as string[] | undefined,
        project: globalOpts.project,
      });
    });
}
