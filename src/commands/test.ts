import process from "node:process";

import { Command, InvalidArgumentError } from "commander";

import { runTests, type TestRunOutcome } from "../test/index.ts";
import { bold, dim, green, log, red, yellow } from "../logging.ts";
import type { ResolvedProject } from "../project.ts";
import type { TestCase } from "../test/runner.ts";
import {
  findWorkspace,
  resolveWorkspaceContext,
  topologicalOrder,
  type WorkspaceContext,
} from "../workspace.ts";

export interface TestCommandOptions {
  filter?: string;
  failFast?: boolean;
  clean?: boolean;
  workspace?: string;
  workspaces?: boolean;
  json?: boolean;
  cwd?: string;
}

export interface TestCommandResult {
  status: "success" | "partial";
  exitCode: 0 | 1;
  results: Array<{
    workspace: string;
    rootDir: string;
    ok: boolean;
    durationMs: number;
    tests?: { total: number; passed: number; failed: number; skipped: number };
    failures?: Array<{
      class: string;
      test: string;
      durationMs: number;
      message?: string;
      stackTrace?: string;
    }>;
    /** "no-test-dir" | "no-sources" when the workspace ran no tests. */
    skipped?: "no-test-dir" | "no-sources";
    /** Set when the workspace errored before tests could run (e.g. compile). */
    error?: string;
  }>;
}

/**
 * Run `pluggy test` across the resolved target set.
 *
 * Compile errors and launcher failures rethrow for single-target calls so the
 * top-level handler formats them; in multi-workspace runs the error is
 * captured into the per-workspace result and we keep going. Test *failures*
 * (asserts) never throw — they surface via `ok: false` + `failures[]`.
 */
export async function runTestCommand(opts: TestCommandOptions): Promise<TestCommandResult> {
  const cwd = opts.cwd ?? process.cwd();
  const context = resolveWorkspaceContext(cwd);
  if (context === undefined) {
    throw new Error("No pluggy project found — run this from inside a project directory.");
  }

  const targets = selectTestTargets(context, opts);

  const results: TestCommandResult["results"] = [];
  let anyFailed = false;

  for (const target of targets) {
    const label = target.name;
    const rootDir = target.rootDir;
    const started = Date.now();

    try {
      if (opts.json !== true) {
        log.info(`${bold("test")} ${label}`);
      }

      const outcome: TestRunOutcome = await runTests(target, {
        filter: opts.filter,
        failFast: opts.failFast,
        clean: opts.clean,
      });

      if (outcome.status === "no-tests") {
        const reason = outcome.reason;
        results.push({
          workspace: label,
          rootDir,
          ok: true,
          durationMs: outcome.durationMs,
          skipped: reason,
        });
        if (opts.json !== true) {
          const msg =
            reason === "no-test-dir"
              ? `${label}: no test/ directory — nothing to run`
              : `${label}: test/ contains no .java sources`;
          log.warn(msg);
        }
        continue;
      }

      const { result, durationMs } = outcome;
      const ok = result.failed === 0;
      if (!ok) anyFailed = true;

      const failures = result.cases
        .filter((c) => c.status === "failed")
        .map((c) => ({
          class: c.suite,
          test: c.name,
          durationMs: c.durationMs,
          message: c.message,
          stackTrace: c.stackTrace,
        }));

      results.push({
        workspace: label,
        rootDir,
        ok,
        durationMs,
        tests: {
          total: result.total,
          passed: result.passed,
          failed: result.failed,
          skipped: result.skipped,
        },
        failures: failures.length > 0 ? failures : undefined,
      });

      if (opts.json !== true) {
        renderHumanResult(label, result.cases, result);
      }
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
      if (opts.json !== true) {
        log.error(`${label}: ${message}`);
      }
      if (targets.length === 1) {
        throw err;
      }
    }
  }

  const exitCode: 0 | 1 = anyFailed ? 1 : 0;
  const status: TestCommandResult["status"] = anyFailed ? "partial" : "success";

  if (opts.json === true) {
    const payload = {
      status: anyFailed ? "error" : "success",
      results: results.map((r) => ({
        workspace: r.workspace,
        rootDir: r.rootDir,
        ok: r.ok,
        durationMs: r.durationMs,
        tests: r.tests,
        failures: r.failures,
        skipped: r.skipped,
        error: r.error,
      })),
    };
    if (anyFailed) {
      console.error(JSON.stringify(payload, null, 2));
    } else {
      console.log(JSON.stringify(payload, null, 2));
    }
  } else if (targets.length > 1) {
    log.info("");
    log.info(bold("summary"));
    for (const r of results) {
      const line = summaryLine(r);
      log.info(`  ${r.workspace}: ${line}`);
    }
  }

  return { status, exitCode, results };
}

/**
 * Pick the workspaces `pluggy test` should cover. Mirrors `selectBuildTargets`
 * exactly — root with workspaces → all in topo order, `--workspace` narrows,
 * inside a workspace → just that one.
 */
export function selectTestTargets(
  context: WorkspaceContext,
  opts: Pick<TestCommandOptions, "workspace" | "workspaces">,
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
        `--workspace "${opts.workspace}" does not match the current workspace "${context.current.name}". Run from the root to test a different workspace.`,
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

function summaryLine(r: TestCommandResult["results"][number]): string {
  if (r.error !== undefined) return `FAILED — ${r.error}`;
  if (r.skipped === "no-test-dir") return "no test/ directory";
  if (r.skipped === "no-sources") return "no .java sources in test/";
  const t = r.tests;
  if (t === undefined) return "ok";
  const parts = [`${t.passed} passed`];
  if (t.failed > 0) parts.push(`${t.failed} failed`);
  if (t.skipped > 0) parts.push(`${t.skipped} skipped`);
  return parts.join(", ") + ` (${r.durationMs}ms)`;
}

function renderHumanResult(
  label: string,
  cases: TestCase[],
  totals: { total: number; passed: number; failed: number; skipped: number },
): void {
  // Group cases by suite classname, preserving discovery order.
  const bySuite = new Map<string, TestCase[]>();
  for (const c of cases) {
    const bucket = bySuite.get(c.suite);
    if (bucket === undefined) bySuite.set(c.suite, [c]);
    else bucket.push(c);
  }

  for (const [suite, entries] of bySuite) {
    log.info(`  ${suite}`);
    for (const c of entries) {
      const glyph =
        c.status === "passed" ? green("✓") : c.status === "failed" ? red("✗") : yellow("○");
      const line = `    ${glyph} ${c.name}`;
      const time = dim(`${c.durationMs}ms`);
      log.info(`${line}  ${time}`);
      if (c.status === "failed") {
        if (c.message !== undefined && c.message.length > 0) {
          log.info(`        ${c.message}`);
        }
        if (c.stackTrace !== undefined) {
          const first = c.stackTrace.split("\n").find((l) => l.trim().startsWith("at "));
          if (first !== undefined) log.info(`        ${first.trim()}`);
        }
      }
    }
  }

  const parts = [`${totals.passed} passed`];
  if (totals.failed > 0) parts.push(`${totals.failed} failed`);
  if (totals.skipped > 0) parts.push(`${totals.skipped} skipped`);
  log.info("");
  log.info(`  ${parts.join(", ")}`);
}

/** Factory for the `pluggy test` commander command. */
export function testCommand(): Command {
  return new Command("test")
    .alias("t")
    .description("Compile and run JUnit tests under test/.")
    .option(
      "--filter <pattern>",
      "Include tests matching classname glob, Class#method, or @tag:<name>.",
    )
    .option("--fail-fast", "Stop after the first test failure.")
    .option("--clean", "Wipe the test build cache before running.")
    .option("--workspace <name>", "Test a single workspace.")
    .option("--workspaces", "Explicit all-workspaces test.")
    .action(async function action(this: Command, options) {
      const globalOpts = this.optsWithGlobals();
      const result = await runTestCommand({
        filter: options.filter,
        failFast: options.failFast === true,
        clean: options.clean === true,
        workspace: options.workspace,
        workspaces: options.workspaces === true,
        json: globalOpts.json === true,
      });
      if (result.exitCode !== 0) {
        process.exit(result.exitCode);
      }
    });
}
