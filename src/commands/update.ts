/**
 * `pluggy update`: move declared dependencies to their latest upstream
 * version.
 *
 * The capability half-existed before this command: bare `pluggy install
 * <name>` re-resolves and rewrites `project.json`. Nothing said so, and the
 * one command whose name matched the intent — `pluggy upgrade` — replaces the
 * pluggy binary. This mirrors the `vp update` / `vp upgrade` split.
 */

import process from "node:process";

import { Command } from "commander";

import { UserError } from "../errors.ts";
import { readLock } from "../lockfile.ts";
import { bold, dim, emit, log } from "../logging.ts";
import { DEFAULT_MAVEN_REGISTRIES, registryUrl } from "../registry.ts";
import type { ResolvedSource } from "../source.ts";
import { parseSource } from "../source.ts";
import {
  projectStartDir,
  resolveScope,
  singleWorkspace,
  workspaceListOption,
  type WorkspaceContext,
} from "../workspace.ts";

import { canonicalizeDeclared, collectDeclared } from "./context.ts";
import { doInstall } from "./install.ts";
import { latestUpstreamVersion } from "./outdated.ts";

export interface UpdateOptions {
  /** Dependency names to update. Empty means every updatable declared dep. */
  names?: string[];
  beta?: boolean;
  dryRun?: boolean;
  workspace?: string;
  workspaces?: boolean;
  /** Global `--project <path>` flag: resolve the project from this file instead of cwd. */
  project?: string;
  cwd?: string;
}

export interface UpdatePlanEntry {
  name: string;
  identifier: string;
  from: string;
  to: string;
}

export interface UpdateResult {
  updated: UpdatePlanEntry[];
  unchanged: string[];
  dryRun: boolean;
}

export async function doUpdate(opts: UpdateOptions = {}): Promise<UpdateResult> {
  const cwd = opts.cwd ?? process.cwd();
  const scope = resolveScope({
    cwd: projectStartDir(opts.project, cwd),
    workspace: opts.workspace,
    workspaces: opts.workspaces,
    requireExplicitAtRoot: false,
    commandName: "update",
  });

  const declared = collectDeclared(scope.targets);
  const byName = new Map<string, ResolvedSource>();
  for (const { name, value } of declared) {
    const canonical = canonicalizeDeclared(name, value);
    byName.set(name, parseSource(canonical.source, canonical.version));
  }

  const requested = opts.names ?? [];
  if (requested.length > 0) {
    for (const name of requested) {
      if (byName.has(name)) continue;
      throw notDeclared(name, scope.context);
    }
  }

  const targets = [...byName.entries()].filter(
    ([name]) => requested.length === 0 || requested.includes(name),
  );

  const registries = unionRegistries(scope.context);
  const plan: UpdatePlanEntry[] = [];
  const unchanged: string[] = [];

  for (const [name, source] of targets) {
    if (source.kind === "file" || source.kind === "workspace") {
      // Local jars and sibling workspaces have no upstream to move to.
      if (requested.includes(name)) {
        log.warn(`${name} is a ${source.kind} dependency and has no upstream version.`);
      }
      continue;
    }
    const latest = await latestUpstreamVersion(source, registries, opts.beta === true);
    if (latest === undefined || latest === source.version) {
      unchanged.push(name);
      continue;
    }
    plan.push({
      name,
      identifier: installIdentifier(source, name),
      from: source.version,
      to: latest,
    });
  }

  if (plan.length > 0 && opts.dryRun !== true) {
    for (const entry of plan) {
      await doInstall({
        plugin: `${entry.identifier}@${entry.to}`,
        beta: opts.beta,
        workspace: opts.workspace,
        workspaces: opts.workspaces,
        project: opts.project,
        cwd,
        quiet: true,
      });
    }
  }

  const result: UpdateResult = { updated: plan, unchanged, dryRun: opts.dryRun === true };
  emitUpdateResult(result);
  return result;
}

/**
 * A name that isn't declared is usually a transitive the user saw in
 * `pluggy outdated`. `install` only writes top-level entries, so saying "not
 * found" would be a dead end; name the parent instead.
 */
function notDeclared(name: string, context: WorkspaceContext): UserError {
  const lock = readLock(context.root.rootDir);
  const entry = lock?.entries[name];
  if (entry !== undefined) {
    const parents = Object.entries(lock?.entries ?? {})
      .filter(([, e]) => e.transitives?.includes(name) === true)
      .map(([parent]) => parent);
    if (parents.length > 0) {
      return new UserError(`"${name}" is a transitive dependency, not one you declared.`, {
        code: "E_UPDATE_TRANSITIVE",
        hint: `Update the dependency that pulls it in: pluggy update ${parents.join(" ")}`,
        context: { name, parents },
      });
    }
  }
  // Maven entries are keyed `<group>:<artifact>` in the lockfile, so a user
  // typing just the artifact lands here. Point at the full key rather than
  // making them go read pluggy.lock.
  const suffixMatches = Object.keys(lock?.entries ?? {}).filter((key) => key.endsWith(`:${name}`));
  if (suffixMatches.length > 0) {
    return new UserError(`"${name}" is not a declared dependency.`, {
      code: "E_UPDATE_NOT_DECLARED",
      hint: `Did you mean ${suffixMatches.map((m) => `"${m}"`).join(" or ")}?`,
      context: { name, suggestions: suffixMatches },
    });
  }

  return new UserError(`"${name}" is not a declared dependency.`, {
    code: "E_UPDATE_NOT_DECLARED",
    hint: "Run `pluggy list` to see what this project declares.",
    context: { name },
  });
}

function installIdentifier(source: ResolvedSource, name: string): string {
  return source.kind === "maven" ? `maven:${source.groupId}:${source.artifactId}` : name;
}

function unionRegistries(context: WorkspaceContext): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (url: string): void => {
    const key = url.endsWith("/") ? url.slice(0, -1) : url;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(url);
  };
  for (const r of context.root.registries ?? []) push(registryUrl(r));
  for (const ws of context.workspaces) {
    for (const r of ws.project.registries ?? []) push(registryUrl(r));
  }
  for (const url of DEFAULT_MAVEN_REGISTRIES) push(url);
  return out;
}

function emitUpdateResult(result: UpdateResult): void {
  emit(
    {
      status: "success",
      dryRun: result.dryRun,
      updated: result.updated,
      unchanged: result.unchanged,
    },
    () => {
      if (result.updated.length === 0) {
        log.success(
          result.unchanged.length === 0
            ? "No updatable dependencies declared."
            : `All ${result.unchanged.length} dependencies are already at their latest version.`,
        );
        return;
      }

      log.heading(result.dryRun ? "Would update" : "Updated");
      const width = Math.max(...result.updated.map((e) => e.name.length));
      for (const entry of result.updated) {
        log.info(`  ${bold(entry.name.padEnd(width))}  ${entry.from} ${dim("→")} ${entry.to}`);
      }
      log.info("");
      if (result.dryRun) {
        log.info(dim("Re-run without --dry-run to apply."));
      } else {
        log.success(
          `${result.updated.length} updated${result.unchanged.length > 0 ? `, ${result.unchanged.length} already current` : ""}.`,
        );
      }
    },
  );
}

export function updateCommand(): Command {
  return new Command("update")
    .description("Update declared dependencies to their latest version.")
    .argument("[names...]", "Dependencies to update. Omit to update every declared dependency.")
    .option("--beta", "Include pre-release versions.")
    .option("--dry-run", "Show what would change without writing anything.")
    .option("--workspace <names>", "Target a specific workspace.", workspaceListOption)
    .option("--workspaces", "Run across every workspace.")
    .addHelpText(
      "after",
      "\nExamples:\n  $ pluggy update\n  $ pluggy update worldedit\n  $ pluggy update --dry-run\n\nTo upgrade pluggy itself, use `pluggy upgrade`.",
    )
    .action(async function action(this: Command, names: string[], options) {
      await doUpdate({
        names,
        beta: options.beta === true,
        dryRun: options.dryRun === true,
        workspace: singleWorkspace(
          options.workspace as string[] | undefined,
          "update",
          "Use --workspaces to update every workspace.",
        ),
        workspaces: options.workspaces === true,
        project: this.optsWithGlobals().project,
      });
    });
}
