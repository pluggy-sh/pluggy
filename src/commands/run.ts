/**
 * `pluggy run <script>`: invoke a named shell task across the selected
 * workspaces. Scripts live under `project.scripts`; they inherit additively
 * from the root.
 *
 * Implementation notes:
 *   • No shell. Per CLAUDE.md cross-platform requirements, we tokenize the
 *     script string into argv and call `spawn(cmd, args, ...)` directly.
 *     Users who want pipes/redirection put a real script file in their repo
 *     and reference it from `scripts`.
 *   • Output is prefixed with `[<workspace>]` so parallel runs stay
 *     readable when multiple workspaces are interleaved on the same
 *     stream.
 *   • Variable substitution: `${project.name}`, `${project.version}`,
 *     `${workspace.rootDir}`, etc. Reuses the template-loader's `replace`.
 */

import { spawn } from "node:child_process";
import { delimiter, join } from "node:path";
import process from "node:process";

import { Command, InvalidArgumentError } from "commander";

import { bold, dim, emit, emitErr, log } from "../logging.ts";
import { runWorkspaces, type RunResult } from "../runner.ts";
import { getCachedJdk } from "../sdk/index.ts";
import { selectJdkForProject } from "../sdk/resolve.ts";
import { replace } from "../template.ts";
import {
  resolveWorkspaceContext,
  selectWorkspaceTargets,
  workspaceListOption,
  type WorkspaceNode,
} from "../workspace.ts";

export interface RunCommandOptions {
  scriptName?: string;
  /** Extra args appended to the tokenized script argv. Use `--` on the CLI. */
  extraArgs?: string[];
  workspace?: string[];
  exclude?: string[];
  workspaces?: boolean;
  concurrency?: number;
  cwd?: string;
}

export interface RunCommandResult {
  status: "success" | "partial" | "list";
  exitCode: 0 | 1;
  results?: Array<{
    workspace: string;
    script: string;
    expanded: string[];
    ok: boolean;
    exitCode: number | null;
    durationMs: number;
    error?: string;
  }>;
  /** Populated when called with no script name; lists what's available. */
  scripts?: Array<{ name: string; workspaces: string[] }>;
}

interface RunOneResult {
  expanded: string[];
  exitCode: number | null;
}

export async function runRunCommand(opts: RunCommandOptions): Promise<RunCommandResult> {
  const cwd = opts.cwd ?? process.cwd();
  const context = resolveWorkspaceContext(cwd);
  if (context === undefined) {
    throw new Error("No pluggy project found. Run this from inside a project directory.");
  }

  if (opts.scriptName === undefined || opts.scriptName.length === 0) {
    return listScripts(context);
  }

  const targets = selectWorkspaceTargets(context, opts, "run");
  // Filter to workspaces that actually define the requested script (after
  // inheritance). A workspace that didn't inherit or override the script is
  // silently skipped — `pluggy run <name>` only runs where it's defined.
  const eligible = targets.filter((node) => {
    const script = node.project.scripts?.[opts.scriptName as string];
    return typeof script === "string" && script.length > 0;
  });
  if (eligible.length === 0) {
    throw new InvalidArgumentError(
      `script "${opts.scriptName}" is not defined in any selected workspace.`,
    );
  }

  const extraArgs = opts.extraArgs ?? [];
  const runResults = await runWorkspaces<RunOneResult>(
    eligible,
    async (node) => runOne(node, opts.scriptName as string, extraArgs),
    { concurrency: opts.concurrency, skipOnUpstreamFailure: false },
  );

  // Single-target failure rethrows so the CLI's top-level handler formats it.
  // Two failure shapes: the runner caught a thrown error (spawn failed) OR
  // the child process exited with a non-zero code.
  if (eligible.length === 1) {
    const single = runResults[0];
    if (single?.status === "failed") {
      throw single.error ?? new Error(`script "${opts.scriptName}" failed`);
    }
    if (single?.status === "ok" && (single.value as RunOneResult).exitCode !== 0) {
      const code = (single.value as RunOneResult).exitCode;
      throw new Error(`script "${opts.scriptName}" exited with code ${code}`);
    }
  }

  const results: NonNullable<RunCommandResult["results"]> = [];
  let anyFailed = false;
  for (const r of runResults) {
    const project = r.workspace.project;
    if (r.status === "ok") {
      const value = r.value as RunOneResult;
      const ok = value.exitCode === 0;
      if (!ok) anyFailed = true;
      results.push({
        workspace: project.name,
        script: opts.scriptName as string,
        expanded: value.expanded,
        ok,
        exitCode: value.exitCode,
        durationMs: r.durationMs,
        error: ok ? undefined : `exit ${value.exitCode}`,
      });
      continue;
    }
    anyFailed = true;
    results.push({
      workspace: project.name,
      script: opts.scriptName as string,
      expanded: [],
      ok: false,
      exitCode: null,
      durationMs: r.durationMs,
      error: r.error?.message ?? "unknown error",
    });
  }

  const exitCode: 0 | 1 = anyFailed ? 1 : 0;
  const status: RunCommandResult["status"] = anyFailed ? "partial" : "success";
  const result: RunCommandResult = { status, exitCode, results };

  const payload = {
    status: anyFailed ? "error" : "success",
    results,
  };
  const printSummary = (): void => {
    if (results.length <= 1) return;
    log.info("");
    log.info(bold("summary"));
    for (const r of results) {
      if (r.ok) {
        log.info(`  ${r.workspace}: ok ${dim(`(${r.durationMs}ms)`)}`);
      } else {
        log.info(`  ${r.workspace}: ${r.error ?? "failed"}`);
      }
    }
  };
  if (anyFailed) emitErr(payload, printSummary);
  else emit(payload, printSummary);

  return result;
}

function listScripts(context: ReturnType<typeof resolveWorkspaceContext>): RunCommandResult {
  const ctx = context as NonNullable<typeof context>;
  const byName = new Map<string, Set<string>>();
  const projects = ctx.workspaces.length > 0 ? ctx.workspaces.map((w) => w.project) : [ctx.root];
  for (const project of projects) {
    for (const name of Object.keys(project.scripts ?? {})) {
      let set = byName.get(name);
      if (set === undefined) {
        set = new Set();
        byName.set(name, set);
      }
      set.add(project.name);
    }
  }
  const scripts = [...byName.entries()]
    .map(([name, workspaces]) => ({ name, workspaces: [...workspaces].sort() }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const result: RunCommandResult = {
    status: "list",
    exitCode: 0,
    scripts,
  };
  emit(result as unknown as Record<string, unknown>, () => {
    if (scripts.length === 0) {
      log.info(dim("No scripts defined. Add a `scripts` block to project.json."));
      return;
    }
    log.heading("Available scripts");
    for (const s of scripts) {
      log.step(`${bold(s.name)} ${dim(`(in: ${s.workspaces.join(", ")})`)}`);
    }
  });
  return result;
}

async function runOne(
  node: WorkspaceNode,
  scriptName: string,
  extraArgs: string[],
): Promise<RunOneResult> {
  const raw = node.project.scripts?.[scriptName];
  if (typeof raw !== "string" || raw.length === 0) {
    throw new Error(`script "${scriptName}" is not defined in workspace "${node.name}"`);
  }
  const expanded = replace(raw, {
    project: { ...node.project },
    workspace: { name: node.name, rootDir: node.root },
  });
  const baseArgv = tokenize(expanded);
  if (baseArgv.length === 0) {
    throw new Error(`script "${scriptName}" expanded to an empty command`);
  }
  const argv = [...baseArgv, ...extraArgs];

  const [cmd, ...args] = argv;
  const prefix = `[${node.name}]`;
  const extraLabel = extraArgs.length > 0 ? ` ${dim(`+ ${extraArgs.join(" ")}`)}` : "";
  log.info(`${dim(prefix)} ${bold(scriptName)}: ${expanded}${extraLabel}`);

  const env = await projectJdkEnv(node);

  return new Promise<RunOneResult>((resolveP, rejectP) => {
    const child = spawn(cmd, args, {
      cwd: node.root,
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });

    const onLine = (stream: "stdout" | "stderr") => (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      for (const line of text.split(/\r?\n/)) {
        if (line.length === 0) continue;
        if (stream === "stdout") log.info(`${dim(prefix)} ${line}`);
        else log.warn(`${dim(prefix)} ${line}`);
      }
    };
    child.stdout?.on("data", onLine("stdout"));
    child.stderr?.on("data", onLine("stderr"));

    child.once("error", (err) => {
      rejectP(new Error(`failed to spawn ${cmd}: ${(err as Error).message}`));
    });
    child.once("close", (exitCode) => {
      resolveP({ expanded: argv, exitCode });
    });
  });
}

/**
 * Build the child env for a workspace, prepending the project's pinned JDK
 * to `PATH` and setting `JAVA_HOME` when a matching JDK is already cached.
 *
 * Cache-only by design: `pluggy run` shouldn't trigger a 200 MB JDK download
 * for a script that may not even invoke Java. `pluggy build` / `pluggy dev`
 * are the commands that auto-install.
 */
async function projectJdkEnv(node: WorkspaceNode): Promise<NodeJS.ProcessEnv> {
  const base = { ...process.env };
  const selection = await selectJdkForProject(node.project);
  const cached = getCachedJdk(selection.major, selection.distribution);
  if (cached === undefined) return base;
  base.JAVA_HOME = cached.javaHome;
  const binDir = join(cached.javaHome, "bin");
  base.PATH = base.PATH !== undefined ? `${binDir}${delimiter}${base.PATH}` : binDir;
  return base;
}

/**
 * Split a script string into argv. Recognises double-quoted segments so
 * `echo "a b"` becomes `["echo", "a b"]`. Single quotes are NOT special —
 * shell behaviour is intentionally not emulated. Users who want full shell
 * features put the work in a script file.
 */
export function tokenize(input: string): string[] {
  const tokens: string[] = [];
  // Matches either a "double-quoted segment" or a run of non-space chars.
  const re = /"((?:\\.|[^"\\])*)"|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(input)) !== null) {
    if (match[1] !== undefined) tokens.push(match[1].replace(/\\(.)/g, "$1"));
    else if (match[2] !== undefined) tokens.push(match[2]);
  }
  return tokens;
}

/** Factory for the `pluggy run` commander command. */
export function runCommand(): Command {
  return new Command("run")
    .description("Invoke a script defined under project.scripts across the selected workspaces.")
    .argument("[name]", "Script name. Omit to list available scripts.")
    .argument(
      "[args...]",
      "Extra args appended to the script invocation. Use -- to separate from pluggy options.",
    )
    .option(
      "--workspace <names>",
      "Run in one or more workspaces (repeatable; comma-separated).",
      workspaceListOption,
      [] as string[],
    )
    .option(
      "--exclude <names>",
      "Exclude workspaces from the default sweep (repeatable; comma-separated).",
      workspaceListOption,
      [] as string[],
    )
    .option("--workspaces", "Explicit all-workspaces run.")
    .option("--concurrency <n>", "Cap on workspaces running simultaneously.", (raw: string) => {
      const n = Number.parseInt(raw, 10);
      if (!Number.isFinite(n) || n < 1) {
        throw new InvalidArgumentError("--concurrency must be a positive integer");
      }
      return n;
    })
    .action(async function action(
      this: Command,
      name: string | undefined,
      extraArgs: string[],
      options,
    ) {
      const result = await runRunCommand({
        scriptName: name,
        extraArgs,
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

/** Helper used by RunResult mapping; kept for type-narrowing clarity. */
export type RunResultEntry<T> = RunResult<T>;
