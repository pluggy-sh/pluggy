import process from "node:process";

import { Command } from "commander";

import { UserError } from "../errors.ts";
import { bold, dim, emit, log, yellow } from "../logging.ts";
import { type LockfileEntry, readLock } from "../lockfile.ts";
import type { Dependency, ResolvedProject } from "../project.ts";
import { DEFAULT_MAVEN_REGISTRIES, registryUrl } from "../registry.ts";
import { parseSource, type ResolvedSource } from "../source.ts";
import { compareVersions } from "../update-check.ts";
import {
  findWorkspace,
  projectStartDir,
  resolveWorkspaceContext,
  type WorkspaceContext,
  type WorkspaceNode,
} from "../workspace.ts";

import { latestUpstreamVersion } from "./outdated.ts";

export interface ListOptions {
  tree?: boolean;
  outdated?: boolean;
  workspace?: string;
  workspaces?: boolean;
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
  /** Latest upstream (Modrinth or Maven) version, populated only when `--outdated` ran. `null` when not queried, has no upstream, or the query failed. */
  latestVersion?: string | null;
  /** True when `latestVersion` is known and newer than the current version. */
  outdated?: boolean;
  /** Error message when the `--outdated` lookup failed for this dep. */
  lookupError?: string;
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

  if (options.outdated) {
    await enrichWithLatestVersions(
      deps,
      registries.map((r) => r.url),
    );
    deps = deps.filter((d) => d.outdated === true || d.lookupError !== undefined);
  }

  const result: ListResult = { scope, deps, registries, target };

  emit({ status: "success", ...result }, () => {
    if (options.tree) {
      printTreeList(result, options.outdated === true);
    } else {
      printHumanList(result, options.outdated === true);
    }
  });

  return result;
}

/**
 * Query upstream (via `latestUpstreamVersion`, the same lookup `pluggy
 * outdated` uses) for the newest stable version of every Modrinth- and
 * Maven-sourced dep and annotate each entry with `latestVersion` +
 * `outdated`. File and workspace entries have no upstream and get
 * `latestVersion: null`. A failed lookup sets `lookupError` so the failure
 * is surfaced instead of rendering as up to date.
 */
async function enrichWithLatestVersions(deps: DepEntry[], registries: string[]): Promise<void> {
  for (const dep of deps) {
    try {
      const latest = await latestUpstreamVersion(dep.source, registries, false);
      if (latest === undefined) {
        dep.latestVersion = null;
        continue;
      }
      dep.latestVersion = latest;
      const current = dep.resolvedVersion ?? dep.declaredVersion;
      dep.outdated = current !== "*" && compareVersions(current, latest) < 0;
    } catch (err) {
      dep.latestVersion = null;
      dep.lookupError = (err as Error).message;
    }
  }
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
  if (scope === "standalone") {
    return [{ declaringName: ctx.root.name, project: ctx.root }];
  }
  if (scope === "workspace") {
    if (options.workspace !== undefined) {
      const node = findWorkspace(ctx, options.workspace);
      return [{ declaringName: node.name, project: node.project }];
    }
    if (ctx.current) {
      return [{ declaringName: ctx.current.name, project: ctx.current.project }];
    }
  }
  return ctx.workspaces.map((w: WorkspaceNode) => ({
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

function printHumanList(result: ListResult, outdatedMode: boolean): void {
  log.info(bold(`${result.scope}: ${result.target}`));
  const shown = outdatedMode ? result.deps.filter((d) => d.lookupError === undefined) : result.deps;
  const failed = outdatedMode ? result.deps.filter((d) => d.lookupError !== undefined) : [];
  if (shown.length === 0) {
    log.info(dim(emptyDepsLine(outdatedMode, failed.length)));
  } else {
    log.info("");
    log.info(bold(outdatedMode ? "outdated dependencies:" : "dependencies:"));
    for (const dep of shown) {
      const resolved = dep.resolvedVersion ?? dim("(unresolved; run install)");
      const decl = result.scope === "root" ? ` ${dim(`[${dep.declaredBy.join(", ")}]`)}` : "";
      const update =
        dep.outdated === true && dep.latestVersion !== null && dep.latestVersion !== undefined
          ? `  ${yellow(`→ ${dep.latestVersion}`)}`
          : "";
      log.info(
        `  ${dep.name}  ${dim(`declared: ${dep.declaredVersion}`)}  ${dim(`resolved:`)} ${resolved}${update}  ${dim(describeSource(dep.source))}${decl}`,
      );
    }
  }
  printLookupFailures(failed);
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
function printTreeList(result: ListResult, outdatedMode: boolean): void {
  log.info(bold(`${result.scope}: ${result.target}`));
  const shown = outdatedMode ? result.deps.filter((d) => d.lookupError === undefined) : result.deps;
  const failed = outdatedMode ? result.deps.filter((d) => d.lookupError !== undefined) : [];
  if (shown.length === 0) {
    log.info(dim(emptyDepsLine(outdatedMode, failed.length)));
  } else {
    log.info("");
    log.info(bold(outdatedMode ? "outdated dependencies:" : "dependencies:"));
    for (let i = 0; i < shown.length; i++) {
      renderDepNode(shown[i], "  ", i === shown.length - 1, /* topLevel */ true);
    }
  }
  printLookupFailures(failed);
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

function emptyDepsLine(outdatedMode: boolean, failedCount: number): string {
  if (!outdatedMode) return "  (no dependencies declared)";
  if (failedCount > 0) return "  (no known-outdated dependencies; some could not be checked)";
  return "  (everything is up to date)";
}

function printLookupFailures(failed: DepEntry[]): void {
  if (failed.length === 0) return;
  log.info("");
  for (const dep of failed) {
    log.warn(`${dep.name}: ${dep.lookupError ?? "lookup failed"}`);
  }
  log.info(
    `${failed.length} ${failed.length === 1 ? "dependency" : "dependencies"} could not be checked (network error).`,
  );
}

/**
 * Render one node of the dep tree and recurse into its children. `prefix`
 * carries the cumulative indentation from ancestors (a mix of `│   ` for
 * open ancestors and `    ` for closed ones). `last` toggles the leaf
 * glyph.
 */
function renderDepNode(dep: DepEntry, prefix: string, last: boolean, topLevel: boolean): void {
  const branch = last ? "└──" : "├──";
  const resolved = dep.resolvedVersion ?? dim("(unresolved)");
  const update =
    topLevel &&
    dep.outdated === true &&
    dep.latestVersion !== null &&
    dep.latestVersion !== undefined
      ? `  ${yellow(`→ ${dep.latestVersion}`)}`
      : "";
  log.info(
    `${prefix}${dim(branch)} ${dep.name}  ${dim(`@${dep.declaredVersion} → ${resolved}`)}${update}  ${dim(describeSource(dep.source))}`,
  );
  const children = dep.children ?? [];
  if (children.length === 0) return;
  const childPrefix = `${prefix}${last ? "    " : "│   "}`;
  for (let i = 0; i < children.length; i++) {
    renderDepNode(children[i], childPrefix, i === children.length - 1, /* topLevel */ false);
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
    .option("--outdated", "Only list deps with newer versions available.")
    .option("--workspace <name>", "Show a specific workspace.")
    .option("--workspaces", "Aggregated view across all workspaces.")
    .action(async function action(this: Command, options) {
      const globalOpts = this.optsWithGlobals();
      await doList({
        tree: options.tree,
        outdated: options.outdated,
        workspace: options.workspace,
        workspaces: options.workspaces,
        project: globalOpts.project,
      });
    });
}
