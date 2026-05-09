import process from "node:process";

import { Command, InvalidArgumentError } from "commander";

import { generateDocs, type DocsResult } from "../docs/index.ts";
import { bold, emit, emitErr, log } from "../logging.ts";
import type { ResolvedProject } from "../project.ts";
import {
  findWorkspace,
  resolveWorkspaceContext,
  topologicalOrder,
  type WorkspaceContext,
} from "../workspace.ts";

export interface DocsCommandOptions {
  output?: string;
  clean?: boolean;
  private?: boolean;
  links?: string[];
  workspace?: string;
  workspaces?: boolean;
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
 * multi-workspace failures continue and surface via `exitCode === 1`.
 */
export async function runDocsCommand(opts: DocsCommandOptions): Promise<DocsCommandResult> {
  const cwd = opts.cwd ?? process.cwd();
  const context = resolveWorkspaceContext(cwd);
  if (context === undefined) {
    throw new Error("No pluggy project found. Run this from inside a project directory.");
  }

  const targets = selectDocsTargets(context, opts);

  const results: DocsCommandResult["results"] = [];
  let anyFailed = false;

  for (const target of targets) {
    const label = target.name;
    const rootDir = target.rootDir;
    const started = Date.now();
    try {
      log.info(`${bold("docs")} ${label}`);
      const res: DocsResult = await generateDocs(target, {
        output: opts.output,
        clean: opts.clean,
        access: opts.private === true ? "private" : "protected",
        links: opts.links,
      });

      results.push({
        workspace: label,
        rootDir,
        ok: true,
        outputPath: res.outputPath,
        fileCount: res.fileCount,
        sizeBytes: res.sizeBytes,
        warnings: res.warnings,
        durationMs: res.durationMs,
      });

      const warnSuffix =
        res.warnings > 0 ? `, ${res.warnings} warning${res.warnings === 1 ? "" : "s"}` : "";
      log.success(
        `${label}: ${res.outputPath} (${res.fileCount} files, ${formatBytes(res.sizeBytes)}${warnSuffix}, ${res.durationMs}ms)`,
      );
    } catch (err) {
      anyFailed = true;
      const message = err instanceof Error ? err.message : String(err);
      results.push({
        workspace: label,
        rootDir,
        ok: false,
        durationMs: Date.now() - started,
        error: message,
      });
      log.error(`${label}: ${message}`);
      if (targets.length === 1) {
        throw err;
      }
    }
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
 * `selectBuildTargets` / `selectTestTargets`: root with workspaces → all in
 * topological order, `--workspace` narrows, inside a workspace → just that
 * one.
 */
export function selectDocsTargets(
  context: WorkspaceContext,
  opts: Pick<DocsCommandOptions, "workspace" | "workspaces">,
): ResolvedProject[] {
  if (context.atRoot && context.workspaces.length > 0) {
    if (opts.workspace !== undefined) {
      const node = findWorkspace(context, opts.workspace);
      return [node.project];
    }
    return topologicalOrder(context.workspaces).map((n) => n.project);
  }

  if (context.current !== undefined) {
    if (opts.workspace !== undefined && opts.workspace !== context.current.name) {
      throw new InvalidArgumentError(
        `--workspace "${opts.workspace}" does not match the current workspace "${context.current.name}". Run from the root to document a different workspace.`,
      );
    }
    if (opts.workspaces === true) {
      throw new InvalidArgumentError(
        "--workspaces is only valid at the repo root; you're inside workspace " +
          `"${context.current.name}".`,
      );
    }
    return [context.current.project];
  }

  if (opts.workspace !== undefined) {
    throw new InvalidArgumentError(
      `--workspace "${opts.workspace}" given but this project declares no workspaces.`,
    );
  }
  return [context.root];
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
    .option("--workspace <name>", "Document a single workspace.")
    .option("--workspaces", "Explicit all-workspaces docs run.")
    .action(async function action(this: Command, options) {
      const result = await runDocsCommand({
        output: options.output,
        clean: options.clean === true,
        private: options.private === true,
        links: options.link as string[] | undefined,
        workspace: options.workspace,
        workspaces: options.workspaces === true,
      });
      if (result.exitCode !== 0) {
        process.exit(result.exitCode);
      }
    });
}
