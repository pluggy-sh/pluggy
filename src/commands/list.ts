import process from "node:process";

import { Command } from "commander";

import { bold, dim, log, yellow } from "../logging.ts";
import { readLock, type TransitiveEntry } from "../lockfile.ts";
import type { Dependency, ResolvedProject } from "../project.ts";
import { DEFAULT_MAVEN_REGISTRIES, registryUrl } from "../registry.ts";
import { getLatestModrinthVersion } from "../resolver/modrinth.ts";
import { parseSource, type ResolvedSource } from "../source.ts";
import {
  findWorkspace,
  resolveWorkspaceContext,
  type WorkspaceContext,
  type WorkspaceNode,
} from "../workspace.ts";

export interface ListOptions {
  tree?: boolean;
  outdated?: boolean;
  workspace?: string;
  workspaces?: boolean;
  json?: boolean;
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
  /** Latest Modrinth version, populated only when `--outdated` ran. `null` when not queried, not Modrinth, or query failed. */
  latestVersion?: string | null;
  /** True when `latestVersion` is known and differs from `resolvedVersion`. */
  outdated?: boolean;
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
 * credentials. Credentials must never appear in the result — it feeds `--json`
 * output and terminal logs.
 */
export async function doList(options: ListOptions): Promise<ListResult> {
  const cwd = options.cwd ?? process.cwd();
  const ctx = resolveWorkspaceContext(cwd);
  if (ctx === undefined) {
    throw new Error(`not inside a pluggy project (from ${cwd})`);
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
        if (lockEntry?.transitives !== undefined && lockEntry.transitives.length > 0) {
          entry.children = lockEntry.transitives.map(transitiveToDepEntry);
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
    await enrichWithLatestVersions(deps);
    deps = deps.filter((d) => d.outdated === true);
  }

  const result: ListResult = { scope, deps, registries, target };

  if (options.json) {
    console.log(JSON.stringify({ status: "success", ...result }, null, 2));
  } else if (options.tree) {
    printTreeList(result, options.outdated === true);
  } else {
    printHumanList(result, options.outdated === true);
  }

  return result;
}

/**
 * Query Modrinth for the newest stable version of every Modrinth-sourced dep
 * and annotate each entry with `latestVersion` + `outdated`. Non-Modrinth
 * entries get `latestVersion: null`. Network failures are logged at debug and
 * the entry is left un-annotated (not marked outdated) so a transient API
 * hiccup doesn't surface a false positive.
 */
async function enrichWithLatestVersions(deps: DepEntry[]): Promise<void> {
  for (const dep of deps) {
    if (dep.source.kind !== "modrinth") {
      dep.latestVersion = null;
      continue;
    }
    try {
      const latest = await getLatestModrinthVersion(dep.source.slug, false);
      if (latest === undefined) {
        dep.latestVersion = null;
        continue;
      }
      dep.latestVersion = latest;
      const current = dep.resolvedVersion ?? dep.declaredVersion;
      dep.outdated = current !== "*" && current !== latest;
    } catch (err) {
      log.debug(`list: outdated check failed for "${dep.name}": ${(err as Error).message}`);
      dep.latestVersion = null;
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
 * Project a `TransitiveEntry` from the lockfile into a child `DepEntry`
 * suitable for `--tree` rendering and JSON output. Recurses into nested
 * transitives so the full subtree is materialized.
 *
 * Transitives aren't user-declared, so `declaredBy` is empty. The
 * `declaredVersion` field has no meaningful value for a transitive — we
 * reuse `resolvedVersion` so consumers don't have to special-case a
 * nullable field.
 */
function transitiveToDepEntry(entry: TransitiveEntry): DepEntry {
  const dep: DepEntry = {
    name: depNameFromSource(entry.source),
    source: entry.source,
    declaredVersion: entry.resolvedVersion,
    resolvedVersion: entry.resolvedVersion,
    integrity: entry.integrity,
    declaredBy: [],
  };
  if (entry.transitives !== undefined && entry.transitives.length > 0) {
    dep.children = entry.transitives.map(transitiveToDepEntry);
  }
  return dep;
}

/**
 * Derive a human-readable dep name from a `ResolvedSource`. Mirrors
 * `pickDepName` in `install.ts` but lives here to keep the list/install
 * seams independent.
 */
function depNameFromSource(source: ResolvedSource): string {
  switch (source.kind) {
    case "modrinth":
      return source.slug;
    case "maven":
      return `${source.groupId}:${source.artifactId}`;
    case "workspace":
      return source.name;
    case "file": {
      const base = source.path.replace(/\\/g, "/").split("/").pop() ?? source.path;
      return base.replace(/\.jar$/i, "") || source.path;
    }
  }
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
  if (result.deps.length === 0) {
    const empty = outdatedMode ? "  (everything is up to date)" : "  (no dependencies declared)";
    log.info(dim(empty));
  } else {
    log.info("");
    log.info(bold(outdatedMode ? "outdated dependencies:" : "dependencies:"));
    for (const dep of result.deps) {
      const resolved = dep.resolvedVersion ?? dim("(unresolved — run install)");
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
 * `--outdated` applies to top-level entries only — transitive outdated
 * checking is a future exercise (would require per-kind latest-version
 * queries through the closure; for now the semantics are: "show me my
 * declared deps that need updates", and transitives come along for the
 * ride when their parent is listed).
 */
function printTreeList(result: ListResult, outdatedMode: boolean): void {
  log.info(bold(`${result.scope}: ${result.target}`));
  if (result.deps.length === 0) {
    const empty = outdatedMode ? "  (everything is up to date)" : "  (no dependencies declared)";
    log.info(dim(empty));
  } else {
    log.info("");
    log.info(bold(outdatedMode ? "outdated dependencies:" : "dependencies:"));
    for (let i = 0; i < result.deps.length; i++) {
      const dep = result.deps[i];
      const last = i === result.deps.length - 1;
      renderDepNode(dep, "  ", last, /* topLevel */ true);
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
        json: globalOpts.json,
        project: globalOpts.project,
      });
    });
}
