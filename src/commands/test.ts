import process from "node:process";

import { Command, InvalidArgumentError } from "commander";

import { runTests, type TestRunOutcome } from "../test/index.ts";
import { bold, dim, green, log, red, yellow } from "../logging.ts";
import { assertSamePlatformFamily } from "../platform/index.ts";
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
  /** Narrow the matrix to one or more MC versions. Empty = no filter. */
  mcVersions?: string[];
  /** Narrow the matrix to one or more platform ids. Empty = no filter. */
  platforms?: string[];
}

export interface TestCellResult {
  mcVersion?: string;
  platformId?: string;
  jdkMajor?: number;
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
  /** "no-test-dir" | "no-sources" when the cell ran no tests. */
  skipped?: "no-test-dir" | "no-sources";
  /** Set when the cell errored before tests could run (e.g. compile). */
  error?: string;
}

export interface TestCommandResult {
  status: "success" | "partial";
  exitCode: 0 | 1;
  results: Array<{
    workspace: string;
    rootDir: string;
    ok: boolean;
    durationMs: number;
    /** Sum of `tests` totals across all cells in this workspace. */
    tests?: { total: number; passed: number; failed: number; skipped: number };
    /** Failures across all cells, each tagged with the cell's coordinates. */
    failures?: Array<{
      class: string;
      test: string;
      durationMs: number;
      message?: string;
      stackTrace?: string;
      mcVersion?: string;
      platformId?: string;
    }>;
    /** Set when every cell hit the same `no-tests` reason (workspace-wide fact). */
    skipped?: "no-test-dir" | "no-sources";
    /** Set when the workspace errored before any cell could run. */
    error?: string;
    /** One entry per (mcVersion × platformId) cell run for this workspace. */
    cells: TestCellResult[];
  }>;
}

/**
 * Run `pluggy test` across the resolved target set.
 *
 * Each project expands into a matrix of `(mcVersion × platformId)` cells —
 * every entry of `compatibility.versions` paired with every entry of
 * `compatibility.platforms`. All platforms must share one family (bukkit,
 * velocity, bungee); mixing families fails matrix expansion before any
 * cell runs. `--mc-version` and `--platform` narrow the matrix down for
 * fast iteration.
 *
 * Compile errors and launcher failures rethrow only when there is exactly
 * one cell across the entire run so the top-level handler formats them;
 * otherwise the error is captured into the per-cell result and the next
 * cell continues. Test *failures* (asserts) never throw — they surface
 * via `ok: false` + `failures[]` on the cell.
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
  // Track the total cell count across all targets so we know whether to
  // rethrow on a single-cell run (matches the prior single-target rethrow).
  // Keep the raw error around so InvalidArgumentError keeps its type when
  // a single-target rethrow surfaces it to the top-level handler.
  const matrices: {
    project: ResolvedProject;
    cells: MatrixCell[];
    error?: { message: string; original: unknown };
  }[] = [];
  for (const target of targets) {
    try {
      matrices.push({ project: target, cells: buildMatrix(target, opts) });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      matrices.push({ project: target, cells: [], error: { message, original: err } });
    }
  }
  const totalCellCount = matrices.reduce((n, m) => n + m.cells.length, 0);
  let anyCellFailed = false;

  let stopAfterWorkspace = false;
  for (const { project, cells, error } of matrices) {
    if (stopAfterWorkspace) break;
    const label = project.name;
    const rootDir = project.rootDir;
    const workspaceStarted = Date.now();

    if (error !== undefined) {
      anyFailed = true;
      results.push({
        workspace: label,
        rootDir,
        ok: false,
        durationMs: 0,
        cells: [],
        error: error.message,
      });
      if (opts.json !== true) {
        log.error(`${label}: ${error.message}`);
      }
      if (targets.length === 1) {
        throw error.original;
      }
      continue;
    }

    if (cells.length === 0) {
      // Matrix filters excluded everything — surface a clear error rather
      // than silently passing.
      anyFailed = true;
      const message =
        "no matrix cells matched — check --mc-version / --platform against compatibility.";
      results.push({
        workspace: label,
        rootDir,
        ok: false,
        durationMs: 0,
        cells: [],
        error: message,
      });
      if (opts.json !== true) log.error(`${label}: ${message}`);
      continue;
    }

    if (opts.json !== true) {
      log.info(
        `${bold("test")} ${label} ${dim(`(${cells.length} cell${cells.length === 1 ? "" : "s"})`)}`,
      );
    }

    const cellResults: TestCellResult[] = [];
    let workspaceOk = true;

    for (const cell of cells) {
      const cellLabel = formatCellLabel(cell);
      const cellStarted = Date.now();

      if (opts.json !== true) {
        log.info(`  ${dim("→")} ${cellLabel}`);
      }

      try {
        const outcome: TestRunOutcome = await runTests(project, {
          filter: opts.filter,
          failFast: opts.failFast,
          clean: opts.clean,
          mcVersion: cell.mcVersion,
          platformId: cell.platformId,
        });

        if (outcome.status === "no-tests") {
          cellResults.push({
            mcVersion: cell.mcVersion,
            platformId: cell.platformId,
            ok: true,
            durationMs: outcome.durationMs,
            skipped: outcome.reason,
          });
          if (opts.json !== true) {
            const msg =
              outcome.reason === "no-test-dir"
                ? `no test/ directory — nothing to run`
                : `test/ contains no .java sources`;
            log.warn(`    ${msg}`);
          }
          // No-tests is the same across every cell (it's a workspace fact),
          // so once we see it we can break out — re-running the matrix would
          // produce identical output.
          break;
        }

        const { result, durationMs, jdkMajor } = outcome;
        const ok = result.failed === 0;
        if (!ok) {
          workspaceOk = false;
          anyCellFailed = true;
        }

        const failures = result.cases
          .filter((c) => c.status === "failed")
          .map((c) => ({
            class: c.suite,
            test: c.name,
            durationMs: c.durationMs,
            message: c.message,
            stackTrace: c.stackTrace,
          }));

        cellResults.push({
          mcVersion: cell.mcVersion,
          platformId: cell.platformId,
          jdkMajor,
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
          renderHumanResult(result.cases, result);
        }

        if (!ok && opts.failFast === true) {
          // Stop the whole run — the user asked to bail on first failure.
          anyFailed = true;
          stopAfterWorkspace = true;
          break;
        }
      } catch (err) {
        workspaceOk = false;
        anyCellFailed = true;
        const message = err instanceof Error ? err.message : String(err);
        cellResults.push({
          mcVersion: cell.mcVersion,
          platformId: cell.platformId,
          ok: false,
          durationMs: Date.now() - cellStarted,
          error: message,
        });
        if (opts.json !== true) {
          log.error(`    ${message}`);
        }
        if (totalCellCount === 1) {
          throw err;
        }
        if (opts.failFast === true) {
          anyFailed = true;
          stopAfterWorkspace = true;
          break;
        }
      }
    }

    if (!workspaceOk) anyFailed = true;

    results.push({
      workspace: label,
      rootDir,
      ok: workspaceOk,
      durationMs: Date.now() - workspaceStarted,
      ...rollupCells(cellResults),
      cells: cellResults,
    });
  }

  if (anyCellFailed) anyFailed = true;

  const exitCode: 0 | 1 = anyFailed ? 1 : 0;
  const status: TestCommandResult["status"] = anyFailed ? "partial" : "success";

  if (opts.json === true) {
    const payload = {
      status: anyFailed ? "error" : "success",
      results,
    };
    if (anyFailed) {
      console.error(JSON.stringify(payload, null, 2));
    } else {
      console.log(JSON.stringify(payload, null, 2));
    }
  } else if (results.length > 1 || (results[0]?.cells.length ?? 0) > 1) {
    log.info("");
    log.info(bold("summary"));
    for (const r of results) {
      if (r.error !== undefined) {
        log.info(`  ${r.workspace}: FAILED — ${r.error}`);
        continue;
      }
      for (const cell of r.cells) {
        const cellLabel = formatCellLabel(cell);
        log.info(`  ${r.workspace} ${dim(cellLabel)}: ${summaryLine(cell)}`);
      }
    }
  }

  return { status, exitCode, results };
}

interface MatrixCell {
  mcVersion?: string;
  platformId?: string;
}

/**
 * Expand a project's compatibility matrix into the cells `pluggy test` will
 * run. Validates that every platform belongs to one family, then takes the
 * cross product of `versions × platforms`. `--mc-version` / `--platform`
 * filter the inputs before expansion; an empty filter array means "no
 * filter" while a non-empty one rejects values that don't match.
 */
export function buildMatrix(project: ResolvedProject, opts: TestCommandOptions): MatrixCell[] {
  const versions = project.compatibility?.versions ?? [];
  const platforms = project.compatibility?.platforms ?? [];

  if (platforms.length > 0) {
    // Throws if platforms come from more than one family — caller catches.
    assertSamePlatformFamily(platforms);
  }

  const versionFilter = opts.mcVersions ?? [];
  const platformFilter = opts.platforms ?? [];

  if (versionFilter.length > 0) {
    for (const v of versionFilter) {
      if (!versions.includes(v)) {
        throw new InvalidArgumentError(
          `--mc-version "${v}" is not declared in compatibility.versions (${versions.join(", ") || "empty"}).`,
        );
      }
    }
  }
  if (platformFilter.length > 0) {
    for (const p of platformFilter) {
      if (!platforms.includes(p)) {
        throw new InvalidArgumentError(
          `--platform "${p}" is not declared in compatibility.platforms (${platforms.join(", ") || "empty"}).`,
        );
      }
    }
  }

  const usedVersions = versionFilter.length > 0 ? versionFilter : versions;
  const usedPlatforms = platformFilter.length > 0 ? platformFilter : platforms;

  // If a project has no compatibility entries at all, emit a single "default"
  // cell — preserves the prior behaviour of testing whatever the project is
  // shaped like (compile-only suites without a platform classpath still work).
  if (usedVersions.length === 0 && usedPlatforms.length === 0) {
    return [{}];
  }
  if (usedVersions.length === 0) {
    return usedPlatforms.map((platformId) => ({ platformId }));
  }
  if (usedPlatforms.length === 0) {
    return usedVersions.map((mcVersion) => ({ mcVersion }));
  }

  const cells: MatrixCell[] = [];
  for (const mcVersion of usedVersions) {
    for (const platformId of usedPlatforms) {
      cells.push({ mcVersion, platformId });
    }
  }
  return cells;
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

interface CellRollup {
  tests?: { total: number; passed: number; failed: number; skipped: number };
  failures?: Array<{
    class: string;
    test: string;
    durationMs: number;
    message?: string;
    stackTrace?: string;
    mcVersion?: string;
    platformId?: string;
  }>;
  skipped?: "no-test-dir" | "no-sources";
  error?: string;
}

/**
 * Aggregate cell results into workspace-level rollup fields. Tests counts
 * sum across cells; failures gain `mcVersion` / `platformId` tags so the
 * caller can tell which cell each failure came from. `skipped` is only
 * surfaced when *every* cell reported the same reason — a per-cell
 * skip otherwise belongs in `cells[i].skipped`. `error` collects every
 * cell's error message into a single newline-joined blob (with cell
 * coordinates prefixed) so simple consumers don't have to walk `cells`.
 */
function rollupCells(cells: TestCellResult[]): CellRollup {
  const out: CellRollup = {};

  let totalRan = 0;
  const totals = { total: 0, passed: 0, failed: 0, skipped: 0 };
  for (const cell of cells) {
    if (cell.tests === undefined) continue;
    totalRan += 1;
    totals.total += cell.tests.total;
    totals.passed += cell.tests.passed;
    totals.failed += cell.tests.failed;
    totals.skipped += cell.tests.skipped;
  }
  if (totalRan > 0) out.tests = totals;

  const failures: NonNullable<CellRollup["failures"]> = [];
  for (const cell of cells) {
    for (const f of cell.failures ?? []) {
      failures.push({
        ...f,
        mcVersion: cell.mcVersion,
        platformId: cell.platformId,
      });
    }
  }
  if (failures.length > 0) out.failures = failures;

  if (cells.length > 0 && cells.every((c) => c.skipped !== undefined)) {
    const reasons = new Set(cells.map((c) => c.skipped));
    if (reasons.size === 1) {
      out.skipped = cells[0].skipped;
    }
  }

  const errorLines: string[] = [];
  for (const cell of cells) {
    if (cell.error === undefined) continue;
    const label = formatCellLabel({ mcVersion: cell.mcVersion, platformId: cell.platformId });
    errorLines.push(label === "default" ? cell.error : `[${label}] ${cell.error}`);
  }
  if (errorLines.length > 0) out.error = errorLines.join("\n");

  return out;
}

function formatCellLabel(cell: MatrixCell): string {
  const parts: string[] = [];
  if (cell.platformId !== undefined) parts.push(cell.platformId);
  if (cell.mcVersion !== undefined) parts.push(cell.mcVersion);
  return parts.length > 0 ? parts.join(" ") : "default";
}

function summaryLine(cell: TestCellResult): string {
  if (cell.error !== undefined) return `FAILED — ${cell.error}`;
  if (cell.skipped === "no-test-dir") return "no test/ directory";
  if (cell.skipped === "no-sources") return "no .java sources in test/";
  const t = cell.tests;
  if (t === undefined) return "ok";
  const parts = [`${t.passed} passed`];
  if (t.failed > 0) parts.push(`${t.failed} failed`);
  if (t.skipped > 0) parts.push(`${t.skipped} skipped`);
  return parts.join(", ") + ` (${cell.durationMs}ms)`;
}

function renderHumanResult(
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
    log.info(`    ${suite}`);
    for (const c of entries) {
      const glyph =
        c.status === "passed" ? green("✓") : c.status === "failed" ? red("✗") : yellow("○");
      const line = `      ${glyph} ${c.name}`;
      const time = dim(`${c.durationMs}ms`);
      log.info(`${line}  ${time}`);
      if (c.status === "failed") {
        if (c.message !== undefined && c.message.length > 0) {
          log.info(`          ${c.message}`);
        }
        if (c.stackTrace !== undefined) {
          const first = c.stackTrace.split("\n").find((l) => l.trim().startsWith("at "));
          if (first !== undefined) log.info(`          ${first.trim()}`);
        }
      }
    }
  }

  const parts = [`${totals.passed} passed`];
  if (totals.failed > 0) parts.push(`${totals.failed} failed`);
  if (totals.skipped > 0) parts.push(`${totals.skipped} skipped`);
  log.info(`    ${parts.join(", ")}`);
}

function parseList(value: string, previous: string[] | undefined): string[] {
  const acc = previous ?? [];
  for (const part of value.split(",")) {
    const trimmed = part.trim();
    if (trimmed.length > 0) acc.push(trimmed);
  }
  return acc;
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
    .option("--fail-fast", "Stop after the first test or matrix-cell failure.")
    .option("--clean", "Wipe the test build cache before running.")
    .option("--workspace <name>", "Test a single workspace.")
    .option("--workspaces", "Explicit all-workspaces test.")
    .option(
      "--mc-version <version>",
      "Narrow the matrix to one MC version (repeatable, comma-separated).",
      parseList,
    )
    .option(
      "--platform <id>",
      "Narrow the matrix to one platform id (repeatable, comma-separated).",
      parseList,
    )
    .action(async function action(this: Command, options) {
      const globalOpts = this.optsWithGlobals();
      const result = await runTestCommand({
        filter: options.filter,
        failFast: options.failFast === true,
        clean: options.clean === true,
        workspace: options.workspace,
        workspaces: options.workspaces === true,
        mcVersions: options.mcVersion,
        platforms: options.platform,
        json: globalOpts.json === true,
      });
      if (result.exitCode !== 0) {
        process.exit(result.exitCode);
      }
    });
}
