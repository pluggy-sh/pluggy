import process from "node:process";

import { Command, InvalidArgumentError } from "commander";

import { generateDocs, type DocsResult } from "../docs/index.ts";
import { bold, dim, emit, emitErr, log } from "../logging.ts";
import { runWorkspaces } from "../runner.ts";
import {
  resolveWorkspaceContext,
  selectWorkspaceTargets,
  workspaceListOption,
  type WorkspaceContext,
  type WorkspaceNode,
} from "../workspace.ts";

export interface DocsCommandOptions {
  output?: string;
  clean?: boolean;
  private?: boolean;
  links?: string[];
  workspace?: string[];
  exclude?: string[];
  workspaces?: boolean;
  /** Cap on workspaces documenting simultaneously. */
  concurrency?: number;
  cwd?: string;
}

export interface DocsCommandResult {
  status: "success" | "partial";
  /** Zero on full success, 1 when at least one workspace failed. */
  exitCode: 0 | 1;
  results: Array<{
    workspace: string;
    rootDir: string;
    ok: boolean;
    outputPath?: string;
    fileCount?: number;
    sizeBytes?: number;
    warnings?: number;
    durationMs: number;
    error?: string;
  }>;
}

/**
 * Run `pluggy docs` against the resolved target set. Mirrors `build`'s
 * orchestration: single-target failures rethrow for the top-level handler,
 * multi-workspace failures continue (no skip-on-upstream since javadoc for
 * `impl` doesn't depend on api's docs succeeding) and surface via
 * `exitCode === 1`.
 */
export async function runDocsCommand(opts: DocsCommandOptions): Promise<DocsCommandResult> {
  const cwd = opts.cwd ?? process.cwd();
  const context = resolveWorkspaceContext(cwd);
  if (context === undefined) {
    throw new Error("No pluggy project found. Run this from inside a project directory.");
  }

  const allTargets = selectDocsTargets(context, opts);
  // Sweep (no explicit --workspace): honor each workspace's `docs: false`
  // opt-out. Explicit --workspace overrides because the user named it.
  const isSweep = (opts.workspace?.length ?? 0) === 0;
  const targets = isSweep ? allTargets.filter((node) => node.project.docs !== false) : allTargets;
  for (const skipped of allTargets) {
    if (targets.includes(skipped)) continue;
    log.info(`${bold("docs")} ${skipped.name} ${dim("(skipped: docs:false)")}`);
  }

  const runResults = await runWorkspaces<DocsResult>(
    targets,
    async (node) => {
      const target = node.project;
      log.info(`${bold("docs")} ${target.name}`);
      const res = await generateDocs(target, {
        output: opts.output,
        clean: opts.clean,
        access: opts.private === true ? "private" : "protected",
        links: opts.links,
      });
      const warnSuffix =
        res.warnings > 0 ? `, ${res.warnings} warning${res.warnings === 1 ? "" : "s"}` : "";
      log.success(
        `${target.name}: ${res.outputPath} (${res.fileCount} files, ${formatBytes(res.sizeBytes)}${warnSuffix}, ${res.durationMs}ms)`,
      );
      return res;
    },
    { concurrency: opts.concurrency, skipOnUpstreamFailure: false },
  );

  if (targets.length === 1 && runResults[0]?.status === "failed") {
    throw runResults[0].error ?? new Error("docs failed");
  }

  const results: DocsCommandResult["results"] = [];
  let anyFailed = false;
  for (const r of runResults) {
    const target = r.workspace.project;
    if (r.status === "ok") {
      const res = r.value as DocsResult;
      results.push({
        workspace: target.name,
        rootDir: target.rootDir,
        ok: true,
        outputPath: res.outputPath,
        fileCount: res.fileCount,
        sizeBytes: res.sizeBytes,
        warnings: res.warnings,
        durationMs: res.durationMs,
      });
      continue;
    }
    anyFailed = true;
    const message =
      r.status === "skipped-upstream-failed"
        ? "skipped: an upstream workspace failed"
        : (r.error?.message ?? "unknown error");
    results.push({
      workspace: target.name,
      rootDir: target.rootDir,
      ok: false,
      durationMs: r.durationMs,
      error: message,
    });
    log.error(`${target.name}: ${message}`);
  }

  const exitCode: 0 | 1 = anyFailed ? 1 : 0;
  const status: DocsCommandResult["status"] = anyFailed ? "partial" : "success";

  const payload = {
    status: anyFailed ? "error" : "success",
    results: results.map((r) => ({
      workspace: r.workspace,
      rootDir: r.rootDir,
      ok: r.ok,
      outputPath: r.outputPath,
      fileCount: r.fileCount,
      sizeBytes: r.sizeBytes,
      warnings: r.warnings,
      durationMs: r.durationMs,
      error: r.error,
    })),
  };
  const printSummary = (): void => {
    if (targets.length <= 1) return;
    log.info("");
    log.info(bold("summary"));
    for (const r of results) {
      if (r.ok) {
        log.info(
          `  ${r.workspace}: ${r.outputPath} (${r.fileCount} files, ${formatBytes(r.sizeBytes ?? 0)}, ${r.durationMs}ms)`,
        );
      } else {
        log.info(`  ${r.workspace}: FAILED: ${r.error ?? "unknown error"}`);
      }
    }
  };
  if (anyFailed) emitErr(payload, printSummary);
  else emit(payload, printSummary);

  return { status, exitCode, results };
}

/**
 * Pick which workspaces `pluggy docs` should cover. Identical contract to
 * `selectBuildTargets` / `selectTestTargets`. Returns `WorkspaceNode[]` so
 * the parallel runner can read the workspace dep graph.
 */
export function selectDocsTargets(
  context: WorkspaceContext,
  opts: Pick<DocsCommandOptions, "workspace" | "exclude" | "workspaces">,
): WorkspaceNode[] {
  return selectWorkspaceTargets(context, opts, "document");
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

/** Factory for the `pluggy docs` commander command. */
export function docsCommand(): Command {
  return new Command("docs")
    .description("Generate Javadoc HTML for the project.")
    .option("--output <path>", "Output directory for the generated site.")
    .option("--clean", "Wipe the output directory before generating.")
    .option("--private", "Include private members (passes -private to javadoc).")
    .option(
      "--link <url>",
      "Cross-link to an external javadoc site. Repeatable.",
      (value: string, prev: string[]) => prev.concat(value),
      [] as string[],
    )
    .option(
      "--workspace <names>",
      "Document one or more workspaces (repeatable; comma-separated).",
      workspaceListOption,
      [] as string[],
    )
    .option(
      "--exclude <names>",
      "Exclude workspaces from the default sweep (repeatable; comma-separated).",
      workspaceListOption,
      [] as string[],
    )
    .option("--workspaces", "Explicit all-workspaces docs run.")
    .option("--concurrency <n>", "Cap on workspaces documenting simultaneously.", (raw: string) => {
      const n = Number.parseInt(raw, 10);
      if (!Number.isFinite(n) || n < 1) {
        throw new InvalidArgumentError("--concurrency must be a positive integer");
      }
      return n;
    })
    .action(async function action(this: Command, options) {
      const result = await runDocsCommand({
        output: options.output,
        clean: options.clean === true,
        private: options.private === true,
        links: options.link as string[] | undefined,
        workspace: options.workspace as string[],
        exclude: options.exclude as string[],
        workspaces: options.workspaces === true,
        concurrency: options.concurrency,
      });
      if (result.exitCode !== 0) {
        process.exit(result.exitCode);
      }
    });
}
