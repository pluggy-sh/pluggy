import process from "node:process";

import { Command, InvalidArgumentError } from "commander";

import { runTests, type TestRunOutcome } from "../test/index.ts";
import { bold, dim, emit, emitErr, green, log, red, yellow } from "../logging.ts";
import { platforms } from "../platform/index.ts";
import type { ResolvedProject } from "../project.ts";
import { runWorkspaces } from "../runner.ts";
import type { TestCase } from "../test/runner.ts";
import {
  resolveWorkspaceContext,
  selectWorkspaceTargets,
  workspaceListOption,
  type WorkspaceContext,
  type WorkspaceNode,
} from "../workspace.ts";

export interface TestCommandOptions {
  filter?: string;
  failFast?: boolean;
  clean?: boolean;
  workspace?: string[];
  exclude?: string[];
  workspaces?: boolean;
  cwd?: string;
  /** Narrow the matrix to one or more MC versions. Empty = no filter. */
  mcVersions?: string[];
  /** Narrow the matrix to one or more platform ids. Empty = no filter. */
  platforms?: string[];
  /** Cap on workspaces running simultaneously. Forced to 1 under `--fail-fast`. */
  concurrency?: number;
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

interface WorkspaceTestOutcome {
  workspaceOk: boolean;
  cells: TestCellResult[];
  /** True when the workspace bailed out under `--fail-fast`. */
  bailed?: boolean;
}

/**
 * Run `pluggy test` across the resolved target set.
 *
 * Each project expands into a matrix of `(mcVersion × platformId)` cells.
 * Workspaces with no shared graph dep run concurrently; under `--fail-fast`
 * the run is serialized so a bail can actually stop the rest of the matrix.
 */
export async function runTestCommand(opts: TestCommandOptions): Promise<TestCommandResult> {
  const cwd = opts.cwd ?? process.cwd();
  const context = resolveWorkspaceContext(cwd);
  if (context === undefined) {
    throw new Error("No pluggy project found. Run this from inside a project directory.");
  }

  const allTargets = selectTestTargets(context, opts);
  // Sweep (no explicit --workspace): honor each workspace's `test: false`
  // opt-out. Explicit --workspace overrides because the user named it.
  const isSweep = (opts.workspace?.length ?? 0) === 0;
  const targets = isSweep ? allTargets.filter((node) => node.project.test !== false) : allTargets;
  for (const skipped of allTargets) {
    if (targets.includes(skipped)) continue;
    log.info(`${bold("test")} ${skipped.name} ${dim("(skipped: test:false)")}`);
  }

  // Pre-build matrices so single-cell rethrow can be decided up front and so
  // a matrix-expansion error surfaces in the workspace's result.
  const matrices: { project: ResolvedProject; cells: MatrixCell[]; error?: Error }[] = [];
  for (const node of targets) {
    const project = node.project;
    try {
      matrices.push({ project, cells: buildMatrix(project, opts) });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      matrices.push({ project, cells: [], error });
    }
  }
  const totalCellCount = matrices.reduce((n, m) => n + m.cells.length, 0);

  // Fail-fast can't cleanly cancel in-flight workspaces, so serialize.
  const concurrency = opts.failFast === true ? 1 : opts.concurrency;
  let bailed = false;

  const runResults = await runWorkspaces<WorkspaceTestOutcome>(
    targets,
    async (node) => {
      const project = node.project;
      const matrix = matrices.find((m) => m.project.rootDir === project.rootDir);
      if (matrix === undefined) {
        // Defensive: shouldn't happen since matrices and targets are 1:1.
        throw new Error(`internal: no matrix entry for workspace "${project.name}"`);
      }
      if (matrix.error !== undefined) throw matrix.error;
      if (matrix.cells.length === 0) {
        throw new InvalidArgumentError(
          "no matrix cells matched. Check --mc-version / --platform against compatibility.",
        );
      }

      if (bailed) {
        return { workspaceOk: true, cells: [], bailed: true };
      }

      log.info(
        `${bold("test")} ${project.name} ${dim(
          `(${matrix.cells.length} cell${matrix.cells.length === 1 ? "" : "s"})`,
        )}`,
      );

      const cellResults: TestCellResult[] = [];
      let workspaceOk = true;

      for (const cell of matrix.cells) {
        if (bailed) break;
        const cellLabel = formatCellLabel(cell);
        const cellStarted = Date.now();
        log.info(`  ${dim("→")} ${cellLabel}`);

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
            log.warn(
              outcome.reason === "no-test-dir"
                ? `    no test/ directory; nothing to run`
                : `    test/ contains no .java sources`,
            );
            // No-tests is workspace-wide; re-running the matrix would
            // produce identical output.
            break;
          }

          const { result, durationMs, jdkMajor } = outcome;
          const ok = result.failed === 0;
          if (!ok) workspaceOk = false;

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

          renderHumanResult(result.cases, result);

          if (!ok && opts.failFast === true) {
            bailed = true;
            break;
          }
        } catch (err) {
          workspaceOk = false;
          const message = err instanceof Error ? err.message : String(err);
          cellResults.push({
            mcVersion: cell.mcVersion,
            platformId: cell.platformId,
            ok: false,
            durationMs: Date.now() - cellStarted,
            error: message,
          });
          log.error(`    ${message}`);
          if (totalCellCount === 1) throw err;
          if (opts.failFast === true) {
            bailed = true;
            break;
          }
        }
      }

      return { workspaceOk, cells: cellResults };
    },
    { concurrency, skipOnUpstreamFailure: false },
  );

  // Single-target failures rethrow so the CLI's top-level handler can format
  // them (matches the pre-runner behavior; preserves InvalidArgumentError
  // type for matrix-expansion errors).
  if (targets.length === 1 && runResults[0]?.status === "failed") {
    throw runResults[0].error ?? new Error("test failed");
  }

  const results: TestCommandResult["results"] = [];
  let anyFailed = false;
  for (const r of runResults) {
    const project = r.workspace.project;
    if (r.status === "failed") {
      anyFailed = true;
      const message = r.error?.message ?? "unknown error";
      results.push({
        workspace: project.name,
        rootDir: project.rootDir,
        ok: false,
        durationMs: r.durationMs,
        cells: [],
        error: message,
      });
      log.error(`${project.name}: ${message}`);
      continue;
    }
    if (r.status === "skipped-upstream-failed") {
      // Not reachable with `skipOnUpstreamFailure: false`, but kept for
      // type-narrowing.
      results.push({
        workspace: project.name,
        rootDir: project.rootDir,
        ok: false,
        durationMs: r.durationMs,
        cells: [],
        error: "skipped: an upstream workspace failed",
      });
      anyFailed = true;
      continue;
    }
    const outcome = r.value as WorkspaceTestOutcome;
    if (outcome.bailed && outcome.cells.length === 0) {
      // Workspace was queued but never started because an earlier
      // workspace bailed under --fail-fast.
      continue;
    }
    if (!outcome.workspaceOk) anyFailed = true;
    results.push({
      workspace: project.name,
      rootDir: project.rootDir,
      ok: outcome.workspaceOk,
      durationMs: r.durationMs,
      ...rollupCells(outcome.cells),
      cells: outcome.cells,
    });
  }

  const exitCode: 0 | 1 = anyFailed ? 1 : 0;
  const status: TestCommandResult["status"] = anyFailed ? "partial" : "success";

  const payload = {
    status: anyFailed ? "error" : "success",
    results,
  };
  const printSummary = (): void => {
    if (results.length <= 1 && (results[0]?.cells.length ?? 0) <= 1) return;
    log.info("");
    log.info(bold("summary"));
    for (const r of results) {
      if (r.error !== undefined) {
        log.info(`  ${r.workspace}: FAILED: ${r.error}`);
        continue;
      }
      for (const cell of r.cells) {
        const cellLabel = formatCellLabel(cell);
        log.info(`  ${r.workspace} ${dim(cellLabel)}: ${summaryLine(cell)}`);
      }
    }
  };
  if (anyFailed) emitErr(payload, printSummary);
  else emit(payload, printSummary);

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
  const declaredPlatforms = project.compatibility?.platforms ?? [];

  if (declaredPlatforms.length > 0) {
    platforms.assertSameFamily(declaredPlatforms);
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
      if (!declaredPlatforms.includes(p)) {
        throw new InvalidArgumentError(
          `--platform "${p}" is not declared in compatibility.platforms (${declaredPlatforms.join(", ") || "empty"}).`,
        );
      }
    }
  }

  const usedVersions = versionFilter.length > 0 ? versionFilter : versions;
  const usedPlatforms = platformFilter.length > 0 ? platformFilter : declaredPlatforms;

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
 * exactly: root with workspaces → all in topo order, `--workspace` narrows,
 * inside a workspace → just that one. Returns `WorkspaceNode[]` so the parallel
 * runner can read the workspace dep graph.
 */
export function selectTestTargets(
  context: WorkspaceContext,
  opts: Pick<TestCommandOptions, "workspace" | "exclude" | "workspaces">,
): WorkspaceNode[] {
  return selectWorkspaceTargets(context, opts, "test");
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
 * surfaced when *every* cell reported the same reason; a per-cell
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
  if (cell.error !== undefined) return `FAILED: ${cell.error}`;
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
    .option(
      "--workspace <names>",
      "Test one or more workspaces (repeatable; comma-separated).",
      workspaceListOption,
      [] as string[],
    )
    .option(
      "--exclude <names>",
      "Exclude workspaces from the default sweep (repeatable; comma-separated).",
      workspaceListOption,
      [] as string[],
    )
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
    .option(
      "--concurrency <n>",
      "Cap on workspaces running simultaneously. Ignored under --fail-fast.",
      (raw: string) => {
        const n = Number.parseInt(raw, 10);
        if (!Number.isFinite(n) || n < 1) {
          throw new InvalidArgumentError("--concurrency must be a positive integer");
        }
        return n;
      },
    )
    .action(async function action(this: Command, options) {
      const result = await runTestCommand({
        filter: options.filter,
        failFast: options.failFast === true,
        clean: options.clean === true,
        workspace: options.workspace as string[],
        exclude: options.exclude as string[],
        workspaces: options.workspaces === true,
        mcVersions: options.mcVersion,
        platforms: options.platform,
        concurrency: options.concurrency,
      });
      if (result.exitCode !== 0) {
        process.exit(result.exitCode);
      }
    });
}
