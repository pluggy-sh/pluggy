/**
 * `pluggy clean`: sweep `bin/` (and optionally `docs/`) across the selected
 * workspaces. Build outputs only — IDE files (`.classpath`, `.project`,
 * `.idea/`) are explicitly out of scope; we don't want a wide-cast clean
 * deleting things the user didn't expect.
 */

import { rm, stat } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";

import { Command, InvalidArgumentError } from "commander";

import { bold, dim, emit, emitErr, log } from "../logging.ts";
import {
  resolveWorkspaceContext,
  selectWorkspaceTargets,
  workspaceListOption,
} from "../workspace.ts";

export interface CleanCommandOptions {
  workspace?: string[];
  exclude?: string[];
  workspaces?: boolean;
  /** Also remove `<workspace>/docs/` directories. */
  docs?: boolean;
  /** Print paths that would be removed without touching disk. */
  dryRun?: boolean;
  cwd?: string;
}

export interface CleanedEntry {
  workspace: string;
  path: string;
  /** True when the directory existed and was removed (or would be in dry-run). */
  removed: boolean;
}

export interface CleanCommandResult {
  status: "success" | "dry-run";
  exitCode: 0;
  wouldRemove?: string[];
  removed?: string[];
  entries: CleanedEntry[];
}

export async function runCleanCommand(opts: CleanCommandOptions = {}): Promise<CleanCommandResult> {
  const cwd = opts.cwd ?? process.cwd();
  const context = resolveWorkspaceContext(cwd);
  if (context === undefined) {
    throw new Error("No pluggy project found. Run this from inside a project directory.");
  }

  const targets = selectWorkspaceTargets(context, opts, "clean");
  const entries: CleanedEntry[] = [];
  const includeDocs = opts.docs === true;

  for (const target of targets) {
    const dirs = ["bin"];
    if (includeDocs) dirs.push("docs");
    for (const sub of dirs) {
      const path = join(target.root, sub);
      const exists = await pathExists(path);
      if (!exists) {
        entries.push({ workspace: target.name, path, removed: false });
        continue;
      }
      if (opts.dryRun === true) {
        entries.push({ workspace: target.name, path, removed: true });
        continue;
      }
      try {
        await rm(path, { recursive: true, force: true });
        entries.push({ workspace: target.name, path, removed: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`failed to remove ${path}: ${message}`);
      }
    }
  }

  const removedPaths = entries.filter((e) => e.removed).map((e) => e.path);
  const result: CleanCommandResult = {
    status: opts.dryRun === true ? "dry-run" : "success",
    exitCode: 0,
    entries,
  };
  if (opts.dryRun === true) {
    result.wouldRemove = removedPaths;
  } else {
    result.removed = removedPaths;
  }

  const printSummary = (): void => {
    if (entries.length === 0) {
      log.info(dim("No workspaces selected; nothing to clean."));
      return;
    }
    const verb = opts.dryRun === true ? "would remove" : "removed";
    if (removedPaths.length === 0) {
      log.info(dim(`${verb}: nothing (no build outputs present)`));
      return;
    }
    log.heading(
      `${bold("clean")} ${verb} ${removedPaths.length} path${removedPaths.length === 1 ? "" : "s"}`,
    );
    for (const entry of entries) {
      if (!entry.removed) continue;
      log.step(`${entry.workspace}: ${entry.path}`);
    }
  };
  emit(result as unknown as Record<string, unknown>, printSummary);
  return result;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Factory for the `pluggy clean` commander command. */
export function cleanCommand(): Command {
  return new Command("clean")
    .description("Remove bin/ build outputs across the selected workspaces.")
    .option(
      "--workspace <names>",
      "Clean one or more workspaces (repeatable; comma-separated).",
      workspaceListOption,
      [] as string[],
    )
    .option(
      "--exclude <names>",
      "Exclude workspaces from the sweep (repeatable; comma-separated).",
      workspaceListOption,
      [] as string[],
    )
    .option("--workspaces", "Explicit all-workspaces clean.")
    .option("--docs", "Also remove <workspace>/docs/ output directories.")
    .option("--dry-run", "Print paths that would be removed without touching disk.")
    .action(async function action(this: Command, options) {
      try {
        await runCleanCommand({
          workspace: options.workspace as string[],
          exclude: options.exclude as string[],
          workspaces: options.workspaces === true,
          docs: options.docs === true,
          dryRun: options.dryRun === true,
        });
      } catch (err) {
        if (err instanceof InvalidArgumentError) throw err;
        // Surface filesystem errors via the JSON-aware error path.
        const message = err instanceof Error ? err.message : String(err);
        emitErr({ status: "error", message, exitCode: 1 }, () => {
          log.error(message);
        });
        process.exit(1);
      }
    });
}
