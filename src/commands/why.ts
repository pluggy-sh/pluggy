import process from "node:process";

import { Command } from "commander";

import { UserError } from "../errors.ts";
import { type LockfileEntry, pulledInBy, readLock } from "../lockfile.ts";
import { bold, dim, emit, log } from "../logging.ts";
import { resolveWorkspaceContext } from "../workspace.ts";

export interface WhyOptions {
  /** Lockfile entry name to trace. */
  name: string;
  cwd?: string;
}

export interface WhyPath {
  /** Names from `name` up to a top-level entry, leaf-first. */
  chain: string[];
  /** Top-level entry's `declaredBy`. Empty when the chain dead-ends with no top-level. */
  declaredBy: string[];
}

export interface WhyResult {
  name: string;
  entry: LockfileEntry;
  /** Every distinct path from `name` to a top-level entry. */
  paths: WhyPath[];
}

export async function doWhy(opts: WhyOptions): Promise<WhyResult> {
  const cwd = opts.cwd ?? process.cwd();
  const context = resolveWorkspaceContext(cwd);
  if (context === undefined) {
    throw new UserError("No pluggy project found. Run this from inside a project directory.", {
      code: "E_WHY_NO_PROJECT",
      hint: "Run `pluggy init` to create a new project, or cd into an existing one.",
    });
  }

  const lock = readLock(context.root.rootDir);
  if (lock === null) {
    throw new UserError("No pluggy.lock found. Run pluggy install first.", {
      code: "E_WHY_NO_LOCKFILE",
      hint: "Run `pluggy install` to generate the lockfile.",
    });
  }

  const entry = lock.entries[opts.name];
  if (entry === undefined) {
    throw new UserError(`No lockfile entry named "${opts.name}".`, {
      code: "E_WHY_NOT_FOUND",
      hint: "Use `pluggy list` to see what's locked.",
      context: { name: opts.name },
    });
  }

  const reverse = pulledInBy(lock);
  const paths = tracePaths(opts.name, lock.entries, reverse);

  const result: WhyResult = { name: opts.name, entry, paths };
  emitWhyResult(result);
  return result;
}

/**
 * Walk reverse edges from `start` until each path reaches a top-level
 * entry (one with `declaredBy.length > 0`). Cycles are bounded by a
 * visited set per path; deduplicates identical chains.
 */
function tracePaths(
  start: string,
  entries: Record<string, LockfileEntry>,
  reverse: Record<string, string[]>,
): WhyPath[] {
  const out: WhyPath[] = [];
  const seenChains = new Set<string>();

  const walk = (chain: string[]): void => {
    const head = chain[chain.length - 1];
    const headEntry = entries[head];
    const parents = reverse[head] ?? [];

    if (headEntry !== undefined && headEntry.declaredBy.length > 0) {
      const key = chain.join("\0");
      if (!seenChains.has(key)) {
        seenChains.add(key);
        out.push({ chain: [...chain], declaredBy: [...headEntry.declaredBy] });
      }
      if (parents.length === 0) return;
    }
    if (parents.length === 0) {
      const key = chain.join("\0");
      if (!seenChains.has(key)) {
        seenChains.add(key);
        out.push({ chain: [...chain], declaredBy: [] });
      }
      return;
    }
    for (const parent of parents) {
      if (chain.includes(parent)) continue;
      walk([...chain, parent]);
    }
  };

  walk([start]);
  return out;
}

function emitWhyResult(result: WhyResult): void {
  emit(
    {
      status: "success",
      name: result.name,
      version: result.entry.resolvedVersion,
      paths: result.paths,
    },
    () => {
      log.info(`${bold(result.name)}@${result.entry.resolvedVersion}`);
      if (result.paths.length === 0) {
        log.step(dim("(no parents found; orphan transitive)"));
        return;
      }
      for (const path of result.paths) {
        for (let i = 1; i < path.chain.length; i++) {
          const parent = path.chain[i];
          const indent = "  ".repeat(i - 1);
          const connector = i === path.chain.length - 1 ? "└─" : "├─";
          log.info(`${indent}${dim(connector)} ${parent}`);
        }
        if (path.declaredBy.length > 0) {
          const indent = "  ".repeat(path.chain.length - 1);
          log.info(`${indent}${dim("↳ declared by:")} ${path.declaredBy.join(", ")}`);
        }
      }
    },
  );
}

export function whyCommand(): Command {
  return new Command("why")
    .description("Trace which top-level dependency pulled in a locked dep.")
    .argument("<name>", "Lockfile entry name to trace.")
    .action(async function action(this: Command, name: string) {
      await doWhy({ name });
    });
}
