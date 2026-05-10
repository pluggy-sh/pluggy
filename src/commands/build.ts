import process from "node:process";

import { Command, InvalidArgumentError } from "commander";

import { buildProject, checkPlatformCompile, type BuildResult } from "../build/index.ts";
import { UserError } from "../errors.ts";
import { bold, dim, emit, emitErr, log, red } from "../logging.ts";
import type { ResolvedProject } from "../project.ts";
import {
  findWorkspace,
  resolveWorkspaceContext,
  topologicalOrder,
  type WorkspaceContext,
} from "../workspace.ts";

export interface BuildCommandOptions {
  output?: string;
  clean?: boolean;
  skipClasspath?: boolean;
  workspace?: string;
  workspaces?: boolean;
  json?: boolean;
  cwd?: string;
}

export interface PlatformCheckResult {
  platform: string;
  ok: boolean;
  durationMs: number;
  error?: string;
}

export interface BuildCommandResult {
  status: "success" | "partial";
  /** Zero on full success, 1 when at least one workspace failed. */
  exitCode: 0 | 1;
  results: Array<{
    workspace: string;
    rootDir: string;
    ok: boolean;
    outputPath?: string;
    sizeBytes?: number;
    durationMs: number;
    error?: string;
    /** Compile-only results for each non-primary platform declared in project.json. */
    platformChecks?: PlatformCheckResult[];
  }>;
}

/**
 * Run `pluggy build` against the resolved target set.
 *
 * Single-target failures rethrow so the CLI's top-level handler formats them;
 * multi-workspace failures continue through remaining targets and are
 * surfaced via `exitCode === 1`. JSON mode writes the success envelope to
 * stdout and the partial-failure envelope to stderr.
 */
export async function runBuildCommand(opts: BuildCommandOptions): Promise<BuildCommandResult> {
  const cwd = opts.cwd ?? process.cwd();
  const context = resolveWorkspaceContext(cwd);
  if (context === undefined) {
    throw new UserError("No pluggy project found. Run this from inside a project directory.", {
      code: "E_BUILD_NO_PROJECT",
      hint: "Run `pluggy init` to create a new project, or cd into an existing one.",
    });
  }

  const targets = selectBuildTargets(context, opts);

  const results: BuildCommandResult["results"] = [];
  let anyFailed = false;

  for (const target of targets) {
    const label = target.name;
    const rootDir = target.rootDir;
    const started = Date.now();
    try {
      log.heading(`Building ${bold(label)}`);
      const res: BuildResult = await buildProject(target, {
        output: opts.output,
        clean: opts.clean,
        skipClasspath: opts.skipClasspath,
      });

      // Compile-check every non-primary platform declared in project.json.
      const extraPlatforms = (target.compatibility?.platforms ?? []).slice(1);
      const platformChecks: PlatformCheckResult[] = [];
      for (const platform of extraPlatforms) {
        const pStart = Date.now();
        try {
          await checkPlatformCompile(target, platform, { clean: opts.clean });
          platformChecks.push({ platform, ok: true, durationMs: Date.now() - pStart });
          log.step(`${platform} compiles ${dim(`(${Date.now() - pStart}ms)`)}`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          platformChecks.push({
            platform,
            ok: false,
            durationMs: Date.now() - pStart,
            error: message,
          });
          log.warn(`${platform}: ${message}`);
          anyFailed = true;
        }
      }

      results.push({
        workspace: label,
        rootDir,
        ok: true,
        outputPath: res.outputPath,
        sizeBytes: res.sizeBytes,
        durationMs: res.durationMs,
        platformChecks: platformChecks.length > 0 ? platformChecks : undefined,
      });
      log.success(
        `${bold(label)} → ${res.outputPath} ${dim(`(${formatBytes(res.sizeBytes)}, ${res.durationMs}ms)`)}`,
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
      log.error(`${bold(label)}: ${message}`);
      if (targets.length === 1) {
        throw err;
      }
    }
  }

  const exitCode: 0 | 1 = anyFailed ? 1 : 0;
  const status: BuildCommandResult["status"] = anyFailed ? "partial" : "success";

  const payload = {
    status: anyFailed ? "error" : "success",
    results,
  };
  const printSummary = (): void => {
    if (targets.length <= 1) return;
    log.heading("Summary");
    for (const r of results) {
      if (r.ok) {
        log.step(
          `${r.workspace} → ${r.outputPath} ${dim(`(${formatBytes(r.sizeBytes ?? 0)}, ${r.durationMs}ms)`)}`,
        );
      } else {
        log.step(`${red(r.workspace)} failed: ${r.error ?? "unknown error"}`);
      }
    }
  };
  if (anyFailed) emitErr(payload, printSummary);
  else emit(payload, printSummary);

  return { status, exitCode, results };
}

/**
 * Resolve which workspaces / projects a build call should cover.
 *
 * At a root with workspaces, defaults to every workspace in topological
 * order; `--workspace` narrows to one. Inside a workspace, builds just that
 * workspace. Standalone projects build themselves. Throws
 * `InvalidArgumentError` on rejected flag combinations.
 */
export function selectBuildTargets(
  context: WorkspaceContext,
  opts: Pick<BuildCommandOptions, "workspace" | "workspaces">,
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
        `--workspace "${opts.workspace}" does not match the current workspace "${context.current.name}". Run from the root to build a different workspace.`,
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

/** Factory for the `pluggy build` commander command. */
export function buildCommand(): Command {
  return new Command("build")
    .alias("b")
    .description("Build the project and output a plugin jar.")
    .option("--output <path>", "Output jar path.")
    .option("--clean", "Wipe build cache before building.")
    .option("--skip-classpath", "Don't regenerate .classpath.")
    .option("--workspace <name>", "Build a single workspace.")
    .option("--workspaces", "Explicit all-workspaces build.")
    .action(async function action(this: Command, options) {
      const result = await runBuildCommand({
        output: options.output,
        clean: options.clean === true,
        skipClasspath: options.skipClasspath === true,
        workspace: options.workspace,
        workspaces: options.workspaces === true,
      });
      if (result.exitCode !== 0) {
        process.exit(result.exitCode);
      }
    });
}
