import process from "node:process";

import { Command, InvalidArgumentError } from "commander";

import { buildProject, checkPlatformCompile, type BuildResult } from "../build/index.ts";
import { watchProject } from "../dev/watch.ts";
import { UserError } from "../errors.ts";
import { bold, dim, emit, emitErr, log, red } from "../logging.ts";
import { runWorkspaces } from "../runner.ts";
import {
  resolveWorkspaceContext,
  selectWorkspaceTargets,
  topologicalOrder,
  workspaceDependencyNames,
  workspaceListOption,
  type WorkspaceContext,
  type WorkspaceNode,
} from "../workspace.ts";

export interface BuildCommandOptions {
  output?: string;
  clean?: boolean;
  skipClasspath?: boolean;
  workspace?: string[];
  exclude?: string[];
  workspaces?: boolean;
  /** Cap on workspaces building simultaneously. Defaults to the runner's default. */
  concurrency?: number;
  /**
   * Watch `src/`, `resources/`, and `project.json` across the selected
   * workspaces. On change, rebuild the changed workspace and every
   * downstream dependent in topological order. Runs until Ctrl-C.
   */
  watch?: boolean;
  /** Debounce interval (ms) for watch-mode file events. Default: 100. */
  watchDebounceMs?: number;
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

interface BuildOneResult {
  build: BuildResult;
  platformChecks: PlatformCheckResult[];
}

/**
 * Run `pluggy build` against the resolved target set.
 *
 * Single-target failures rethrow so the CLI's top-level handler formats them;
 * multi-workspace failures continue through remaining targets (skipping
 * dependents whose upstream failed) and are surfaced via `exitCode === 1`.
 *
 * When `opts.watch` is set, an initial build runs and then file watchers
 * stay open per workspace; each change triggers a rebuild of the changed
 * workspace and every downstream dependent in topological order. The
 * promise resolves only when the watch loop is cancelled (SIGINT).
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

  const initial = await buildTargets(targets, opts);

  if (opts.watch === true) {
    await runWatchLoop(targets, opts);
  }

  return initial;
}

async function buildTargets(
  targets: WorkspaceNode[],
  opts: BuildCommandOptions,
): Promise<BuildCommandResult> {
  const runResults = await runWorkspaces<BuildOneResult>(
    targets,
    async (node) => {
      const target = node.project;
      const label = target.name;
      log.heading(`Building ${bold(label)}`);
      const build = await buildProject(target, {
        output: opts.output,
        clean: opts.clean,
        skipClasspath: opts.skipClasspath,
      });

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
        }
      }

      log.success(
        `${bold(label)} → ${build.outputPath} ${dim(`(${formatBytes(build.sizeBytes)}, ${build.durationMs}ms)`)}`,
      );
      return { build, platformChecks };
    },
    { concurrency: opts.concurrency },
  );

  const results: BuildCommandResult["results"] = [];
  let anyFailed = false;
  for (const r of runResults) {
    const target = r.workspace.project;
    if (r.status === "ok") {
      const value = r.value as BuildOneResult;
      const platformFailed = value.platformChecks.some((p) => !p.ok);
      if (platformFailed) anyFailed = true;
      results.push({
        workspace: target.name,
        rootDir: target.rootDir,
        ok: true,
        outputPath: value.build.outputPath,
        sizeBytes: value.build.sizeBytes,
        durationMs: value.build.durationMs,
        platformChecks: value.platformChecks.length > 0 ? value.platformChecks : undefined,
      });
      continue;
    }
    anyFailed = true;
    if (r.status === "skipped-upstream-failed") {
      results.push({
        workspace: target.name,
        rootDir: target.rootDir,
        ok: false,
        durationMs: r.durationMs,
        error: "skipped: an upstream workspace failed to build",
      });
      log.warn(`${bold(target.name)}: skipped (upstream failure)`);
      continue;
    }
    const message = r.error?.message ?? "unknown error";
    results.push({
      workspace: target.name,
      rootDir: target.rootDir,
      ok: false,
      durationMs: r.durationMs,
      error: message,
    });
    log.error(`${bold(target.name)}: ${message}`);
    if (targets.length === 1) {
      throw r.error ?? new Error(message);
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
 * Watch every selected workspace and rebuild on change. The changed
 * workspace plus every downstream dependent (transitive) are rebuilt in
 * topological order. Returns only when SIGINT cancels the loop.
 *
 * Watch-mode output stays unbuffered: users expect live progress as they
 * iterate, even when `--concurrency > 1`.
 */
async function runWatchLoop(allTargets: WorkspaceNode[], opts: BuildCommandOptions): Promise<void> {
  if (allTargets.length === 0) return;
  const debounceMs = opts.watchDebounceMs ?? 100;
  const reverseGraph = computeReverseDependents(allTargets);
  const byName = new Map(allTargets.map((n) => [n.name, n]));

  // Pending set: every workspace queued for the next rebuild. Coalesces
  // bursts of changes across workspaces.
  const pending = new Set<string>();
  let building = false;

  const flush = async (): Promise<void> => {
    if (pending.size === 0 || building) return;
    building = true;
    const names = Array.from(pending);
    pending.clear();
    const subset = topologicalOrder(
      names.map((n) => byName.get(n)).filter((n): n is WorkspaceNode => n !== undefined),
    );
    log.heading(
      `Rebuild triggered for ${subset.length} workspace${subset.length === 1 ? "" : "s"} (${subset.map((s) => s.name).join(", ")})`,
    );
    await buildTargets(subset, { ...opts, watch: false }).catch((err) => {
      log.error(err instanceof Error ? err.message : String(err));
    });
    building = false;
    // If new events landed during the build, drain immediately.
    if (pending.size > 0) {
      void flush();
    }
  };

  const queue = (workspace: string): void => {
    pending.add(workspace);
    for (const dependent of reverseGraph.get(workspace) ?? []) {
      pending.add(dependent);
    }
    void flush();
  };

  const disposers: Array<() => void> = [];
  for (const node of allTargets) {
    const dispose = watchProject(node.project, {
      debounceMs,
      onChange: async () => {
        queue(node.name);
      },
    });
    disposers.push(dispose);
  }

  log.info(
    `${dim("→")} watching ${allTargets.length} workspace${allTargets.length === 1 ? "" : "s"} (${allTargets.map((n) => n.name).join(", ")}); ctrl-c to stop`,
  );

  // Wait until SIGINT. Resolve via a one-shot listener that also disposes.
  await new Promise<void>((resolve) => {
    const handler = (): void => {
      log.info(`${dim("→")} watch stopped`);
      for (const d of disposers) d();
      process.off("SIGINT", handler);
      resolve();
    };
    process.on("SIGINT", handler);
  });
}

/**
 * Build the reverse dep map: workspace name → set of workspaces (in the
 * selection) that transitively depend on it. Used to decide which
 * downstream workspaces a single file change should rebuild.
 */
function computeReverseDependents(nodes: WorkspaceNode[]): Map<string, Set<string>> {
  const direct = new Map<string, Set<string>>();
  for (const n of nodes) direct.set(n.name, new Set());
  for (const n of nodes) {
    for (const depName of workspaceDependencyNames(n)) {
      const bucket = direct.get(depName);
      if (bucket !== undefined) bucket.add(n.name);
    }
  }

  // Transitive close.
  const result = new Map<string, Set<string>>();
  for (const name of direct.keys()) {
    const visited = new Set<string>();
    const stack = [...(direct.get(name) ?? [])];
    while (stack.length > 0) {
      const next = stack.pop() as string;
      if (visited.has(next)) continue;
      visited.add(next);
      stack.push(...(direct.get(next) ?? []));
    }
    result.set(name, visited);
  }
  return result;
}

/**
 * Resolve which workspaces a build call should cover.
 *
 * At a root with workspaces, defaults to every workspace in topological
 * order; `--workspace` narrows to one. Inside a workspace, builds just that
 * workspace. Standalone projects build themselves (returned as a synthetic
 * single-node list so the runner pipeline is uniform). Throws
 * `InvalidArgumentError` on rejected flag combinations.
 */
export function selectBuildTargets(
  context: WorkspaceContext,
  opts: Pick<BuildCommandOptions, "workspace" | "exclude" | "workspaces">,
): WorkspaceNode[] {
  return selectWorkspaceTargets(context, opts, "build");
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
    .option(
      "--workspace <names>",
      "Build one or more workspaces (repeatable; comma-separated).",
      workspaceListOption,
      [] as string[],
    )
    .option(
      "--exclude <names>",
      "Exclude workspaces from the default sweep (repeatable; comma-separated).",
      workspaceListOption,
      [] as string[],
    )
    .option("--workspaces", "Explicit all-workspaces build.")
    .option(
      "--concurrency <n>",
      "Cap on workspaces building simultaneously. Use 1 for serial output.",
      (raw: string) => {
        const n = Number.parseInt(raw, 10);
        if (!Number.isFinite(n) || n < 1) {
          throw new InvalidArgumentError("--concurrency must be a positive integer");
        }
        return n;
      },
    )
    .option(
      "--watch",
      "After the initial build, watch source and rebuild affected workspaces on change.",
    )
    .action(async function action(this: Command, options) {
      const result = await runBuildCommand({
        output: options.output,
        clean: options.clean === true,
        skipClasspath: options.skipClasspath === true,
        workspace: options.workspace as string[],
        exclude: options.exclude as string[],
        workspaces: options.workspaces === true,
        concurrency: options.concurrency,
        watch: options.watch === true,
      });
      if (result.exitCode !== 0) {
        process.exit(result.exitCode);
      }
    });
}
