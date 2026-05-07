/**
 * `pluggy cache` — introspect and manage everything pluggy keeps under
 * `getCachePath()`. JDK toolchain commands (`pluggy sdk install/list/...`)
 * stay where they are; this surface exists for the cross-cutting "what is
 * eating my disk and how do I clean it up" question.
 *
 * Subcommands:
 *   info (default)       Summary table — entries + bytes per category.
 *   list [--category]    Per-entry listing.
 *   path                 Print the cache root (scriptable: `cd "$(pluggy cache path)"`).
 *   clean [--category]   Wipe a category (or everything).
 *   prune [--max-age]    Budget-driven LRU eviction. Safe one-shot defaults.
 */

import process from "node:process";

import { Command, InvalidArgumentError } from "commander";
import { confirm } from "@inquirer/prompts";

import {
  CATEGORY_IDS,
  type CacheSummary,
  type CategoryId,
  cleanCache,
  formatBytes,
  isCategoryId,
  listCacheEntries,
  parseDurationMs,
  parseSizeBytes,
  pruneCache,
  scanCache,
} from "../cache/index.ts";
import { bold, dim, log, yellow } from "../logging.ts";
import { getCachePath } from "../project.ts";

interface CacheGlobalOpts {
  json?: boolean;
}

const DEFAULT_MAX_AGE = "90d";

/** Top-level `cache` command. Subcommands attached below. */
export function cacheCommand(): Command {
  const cmd = new Command("cache").description(
    "Inspect and manage pluggy's on-disk cache (JDKs, server jars, dependencies, BuildTools).",
  );

  // No-arg invocation (`pluggy cache`) prints the same summary as `cache info`.
  cmd.action(async function action(this: Command) {
    const globalOpts = this.optsWithGlobals() as CacheGlobalOpts;
    await runInfo(globalOpts);
  });

  cmd.addCommand(infoSubcommand());
  cmd.addCommand(listSubcommand());
  cmd.addCommand(pathSubcommand());
  cmd.addCommand(cleanSubcommand());
  cmd.addCommand(pruneSubcommand());

  return cmd;
}

// ---------------------------------------------------------------------------
// info
// ---------------------------------------------------------------------------

function infoSubcommand(): Command {
  return new Command("info")
    .description("Show cache size by category. Default if no subcommand is given.")
    .action(async function action(this: Command) {
      const globalOpts = this.optsWithGlobals() as CacheGlobalOpts;
      await runInfo(globalOpts);
    });
}

async function runInfo(globalOpts: CacheGlobalOpts): Promise<void> {
  const summary = await scanCache();

  if (globalOpts.json === true) {
    emitJson({ status: "success", ...summary });
    return;
  }

  log.info(`${bold("cache")} ${dim(summary.cachePath)}`);
  log.info("");

  printCategoryRow("jdk", summary.categories.jdk);
  printCategoryRow("versions", summary.categories.versions);
  printCategoryRow("buildtools", summary.categories.buildtools);
  printCategoryRow("dependencies", summary.categories.dependencies);
  if (summary.categories.dependencies.entries > 0) {
    printSubRow("maven", summary.categories.dependencies.maven);
    printSubRow("modrinth", summary.categories.dependencies.modrinth);
    printSubRow("file", summary.categories.dependencies.file);
  }
  printCategoryRow("jbr", summary.categories.jbr);
  printCategoryRow("hotswap", summary.categories.hotswap);

  log.info("");
  log.info(`  ${bold("total")}  ${formatBytes(summary.totalBytes)}`);
}

function printCategoryRow(name: string, c: { entries: number; bytes: number }): void {
  const label = name.padEnd(14);
  const entries = c.entries === 1 ? "1 entry" : `${c.entries} entries`;
  const size = formatBytes(c.bytes);
  log.info(`  ${label} ${size.padStart(10)}  ${dim(entries)}`);
}

function printSubRow(name: string, c: { entries: number; bytes: number }): void {
  const label = `  └ ${name}`.padEnd(14);
  const entries = c.entries === 1 ? "1 entry" : `${c.entries} entries`;
  const size = formatBytes(c.bytes);
  log.info(`  ${dim(label)} ${dim(size.padStart(10))}  ${dim(entries)}`);
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

function listSubcommand(): Command {
  return new Command("list")
    .alias("ls")
    .description("List individual cache entries.")
    .option("--category <name>", "Limit to one category.", parseCategoryArg)
    .action(async function action(this: Command, options) {
      const globalOpts = this.optsWithGlobals() as CacheGlobalOpts;
      const category: CategoryId | "all" = (options.category as CategoryId | undefined) ?? "all";
      const groups = await listCacheEntries(category);

      if (globalOpts.json === true) {
        emitJson({ status: "success", category, groups });
        return;
      }

      let printed = 0;
      for (const group of groups) {
        if (group.entries.length === 0) continue;
        log.info(bold(group.category));
        // Newest first so the top of the listing is what the user just touched.
        const sorted = [...group.entries].sort((a, b) => b.lastUsedMs - a.lastUsedMs);
        for (const entry of sorted) {
          const sub = entry.subcategory === undefined ? "" : `${dim(`[${entry.subcategory}]`)} `;
          const used = formatRelative(entry.lastUsedMs);
          log.info(`  ${sub}${entry.id}  ${dim(formatBytes(entry.bytes))}  ${dim(`(${used})`)}`);
        }
        log.info("");
        printed += group.entries.length;
      }
      if (printed === 0) {
        log.info(`Cache is empty${category !== "all" ? ` in category "${category}"` : ""}.`);
      }
    });
}

// ---------------------------------------------------------------------------
// path
// ---------------------------------------------------------------------------

function pathSubcommand(): Command {
  return new Command("path")
    .description("Print the cache directory path. Useful in shell scripts.")
    .action(async function action(this: Command) {
      const globalOpts = this.optsWithGlobals() as CacheGlobalOpts;
      const cachePath = getCachePath();
      if (globalOpts.json === true) {
        emitJson({ status: "success", cachePath });
        return;
      }
      process.stdout.write(`${cachePath}\n`);
    });
}

// ---------------------------------------------------------------------------
// clean
// ---------------------------------------------------------------------------

function cleanSubcommand(): Command {
  return new Command("clean")
    .description("Delete all cached entries (or just one category).")
    .option("--category <name>", "Limit cleaning to one category.", parseCategoryArg)
    .option("-y, --yes", "Skip the confirmation prompt.")
    .action(async function action(this: Command, options) {
      const globalOpts = this.optsWithGlobals() as CacheGlobalOpts;
      const category: CategoryId | "all" = (options.category as CategoryId | undefined) ?? "all";
      const skipPrompt = options.yes === true || globalOpts.json === true;

      const summary = await scanCache();
      const target = describeTarget(category, summary);
      if (target.bytes === 0) {
        if (globalOpts.json === true) {
          emitJson({ status: "success", action: "clean", category, removed: [], freedBytes: 0 });
          return;
        }
        log.info(`Nothing to clean${category !== "all" ? ` in "${category}"` : ""}.`);
        return;
      }

      if (!skipPrompt) {
        const ok = await confirm({
          message: `Delete ${target.label} (${formatBytes(target.bytes)})?`,
          default: false,
        });
        if (!ok) {
          log.info("Aborted.");
          return;
        }
      }

      const result = await cleanCache(category);
      if (globalOpts.json === true) {
        emitJson({ status: "success", action: "clean", category, ...result });
        return;
      }
      log.success(
        `Removed ${result.removed.length} entr${result.removed.length === 1 ? "y" : "ies"} (${formatBytes(result.freedBytes)}).`,
      );
    });
}

function describeTarget(
  category: CategoryId | "all",
  summary: CacheSummary,
): { label: string; bytes: number } {
  if (category === "all") {
    return { label: "the entire cache", bytes: summary.totalBytes };
  }
  const c = summary.categories[category];
  const bytes = "bytes" in c ? c.bytes : 0;
  return { label: `the "${category}" category`, bytes };
}

// ---------------------------------------------------------------------------
// prune
// ---------------------------------------------------------------------------

function pruneSubcommand(): Command {
  return new Command("prune")
    .description(
      "Evict stale cache entries. Defaults: drop anything not used in 90 days; keep the 2 most-recent JDKs per major.",
    )
    .option(
      "--max-age <duration>",
      `Drop entries older than this (e.g. 90d, 12h, 30m, 1w). Default: ${DEFAULT_MAX_AGE}. Use 0 to disable.`,
      DEFAULT_MAX_AGE,
    )
    .option(
      "--max-size <size>",
      "After age pruning, evict oldest entries until total is at or below this budget (e.g. 5G, 500M).",
    )
    .option(
      "--keep-latest <n>",
      "JDK-only: keep the N most-recently-used JDKs per major regardless of age. Default: 2.",
      parseKeepLatest,
      2,
    )
    .option("--category <name>", "Limit pruning to one category.", parseCategoryArg)
    .option("--dry-run", "Print what would be removed without touching disk.")
    .action(async function action(this: Command, options) {
      const globalOpts = this.optsWithGlobals() as CacheGlobalOpts;
      const maxAgeMs = parseDurationOrZero(options.maxAge as string);
      const maxBytes =
        options.maxSize === undefined ? undefined : parseSizeArg(options.maxSize as string);
      const keepLatest = options.keepLatest as number;
      const category: CategoryId | "all" = (options.category as CategoryId | undefined) ?? "all";
      const dryRun = options.dryRun === true;

      const result = await pruneCache({ maxAgeMs, maxBytes, keepLatest, category, dryRun });

      if (globalOpts.json === true) {
        emitJson({ status: "success", action: "prune", ...result });
        return;
      }

      if (result.removed.length === 0) {
        log.info(`Nothing to prune (${result.kept.length} kept).`);
        return;
      }
      for (const r of result.removed) {
        log.info(
          `  ${yellow("-")} ${r.category}/${r.id} ${dim(`(${r.reason}, ${formatBytes(r.bytes)})`)}`,
        );
      }
      const verb = dryRun ? "Would evict" : "Evicted";
      log.success(
        `${verb} ${result.removed.length}; kept ${result.kept.length}. Freed ${formatBytes(result.freedBytes)}.`,
      );
    });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseCategoryArg(value: string): CategoryId {
  if (!isCategoryId(value)) {
    throw new InvalidArgumentError(
      `unknown category "${value}". Allowed: ${CATEGORY_IDS.join(", ")}`,
    );
  }
  return value;
}

function parseKeepLatest(value: string): number {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n) || n < 0) {
    throw new InvalidArgumentError(`--keep-latest must be a non-negative integer (got "${value}")`);
  }
  return n;
}

function parseDurationOrZero(value: string): number {
  if (value === "0") return 0;
  try {
    return parseDurationMs(value);
  } catch (err) {
    throw new InvalidArgumentError((err as Error).message);
  }
}

function parseSizeArg(value: string): number {
  try {
    return parseSizeBytes(value);
  } catch (err) {
    throw new InvalidArgumentError((err as Error).message);
  }
}

function emitJson(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function formatRelative(epochMs: number): string {
  const diff = Date.now() - epochMs;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}
