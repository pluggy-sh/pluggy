/**
 * Parallel topological runner for workspace-aware commands.
 *
 * Each target's promise awaits the promises of its `workspace:` deps before
 * starting, then acquires a slot in a fixed-size semaphore so concurrency
 * never exceeds the cap. When a dep fails, transitive dependents settle as
 * `skipped-upstream-failed` without running.
 *
 * Why dynamic over level-based: a level scheduler stalls a workspace whose
 * deps are already done if a sibling at the same level is still running.
 * Dynamic scheduling starts each workspace as soon as its prerequisites
 * resolve, which is the parallelism users actually expect.
 */

import { cpus } from "node:os";

import { flushLogBuffer, withLogBuffer } from "./logging.ts";
import { topologicalOrder, workspaceDependencyNames, type WorkspaceNode } from "./workspace.ts";

export interface RunOptions {
  /**
   * Maximum number of workspaces running simultaneously. Default
   * `min(os.cpus().length, 4)`. `1` matches serial execution.
   */
  concurrency?: number;
  /**
   * When `true` (default), a workspace whose `workspace:` dep failed is
   * settled as `skipped-upstream-failed` without running. Right for `build`
   * (no upstream jar = no point trying). `false` lets every workspace run
   * regardless of upstream status — right for `test` and `docs`, where
   * impl's tests / docs don't actually require api's tests / docs to pass.
   */
  skipOnUpstreamFailure?: boolean;
  /**
   * When set, log output from each workspace is captured and flushed as a
   * block when that workspace settles. Keeps parallel runs readable
   * (interleaved chatter is the default cost of `--concurrency > 1`).
   *
   * Defaults to `true` when the effective concurrency is `> 1`. Set
   * explicitly to `false` to keep the live-streamed behavior, e.g. when
   * the user wants progress feedback on long-running workspaces.
   */
  bufferOutput?: boolean;
}

export type RunStatus = "ok" | "failed" | "skipped-upstream-failed";

export interface RunResult<T> {
  workspace: WorkspaceNode;
  status: RunStatus;
  /** Present when `status === "ok"`. */
  value?: T;
  /** Present when `status === "failed"`. */
  error?: Error;
  durationMs: number;
}

/**
 * Run `runOne` against every target, honoring the workspace dep graph and a
 * concurrency cap. Results come back in topological order so callers can
 * print summaries without re-sorting.
 *
 * The promise never rejects: per-target failures land in the result list
 * with `status: "failed"`. Callers decide whether to surface them as
 * `exitCode === 1` (matching the existing build/test/docs sweep semantics).
 */
export async function runWorkspaces<T>(
  targets: WorkspaceNode[],
  runOne: (node: WorkspaceNode) => Promise<T>,
  opts: RunOptions = {},
): Promise<RunResult<T>[]> {
  if (targets.length === 0) return [];

  const concurrency = Math.max(1, opts.concurrency ?? Math.min(cpus().length, 4));
  const skipOnUpstreamFailure = opts.skipOnUpstreamFailure ?? true;
  const bufferOutput = opts.bufferOutput ?? concurrency > 1;
  const semaphore = new Semaphore(concurrency);
  const ordered = topologicalOrder(targets);
  const inSelection = new Set(ordered.map((n) => n.name));
  const promises = new Map<string, Promise<RunResult<T>>>();

  for (const node of ordered) {
    const depNames = workspaceDependencyNames(node).filter((n) => inSelection.has(n));
    const depPromises = depNames
      .map((d) => promises.get(d))
      .filter((p): p is Promise<RunResult<T>> => p !== undefined);

    const promise = (async (): Promise<RunResult<T>> => {
      const started = Date.now();
      const depResults = await Promise.all(depPromises);
      if (skipOnUpstreamFailure && depResults.some((r) => r.status !== "ok")) {
        return {
          workspace: node,
          status: "skipped-upstream-failed",
          durationMs: Date.now() - started,
        };
      }
      await semaphore.acquire();
      try {
        if (bufferOutput) {
          // Capture every log line emitted under runOne, then flush the
          // whole block atomically — success or failure.
          const captured = await withLogBuffer(node.name, () => runOne(node));
          flushLogBuffer(captured.buffer);
          if (captured.error !== undefined) {
            return {
              workspace: node,
              status: "failed",
              error: captured.error,
              durationMs: Date.now() - started,
            };
          }
          return {
            workspace: node,
            status: "ok",
            value: captured.value as T,
            durationMs: Date.now() - started,
          };
        }
        const value = await runOne(node);
        return {
          workspace: node,
          status: "ok",
          value,
          durationMs: Date.now() - started,
        };
      } catch (err) {
        return {
          workspace: node,
          status: "failed",
          error: err instanceof Error ? err : new Error(String(err)),
          durationMs: Date.now() - started,
        };
      } finally {
        semaphore.release();
      }
    })();
    promises.set(node.name, promise);
  }

  return Promise.all(ordered.map((n) => promises.get(n.name) as Promise<RunResult<T>>));
}

/** Minimal counting semaphore over an internal waiters queue. */
class Semaphore {
  private available: number;
  private waiters: Array<() => void> = [];

  constructor(slots: number) {
    this.available = slots;
  }

  async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available--;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  release(): void {
    const next = this.waiters.shift();
    if (next !== undefined) {
      next();
      return;
    }
    this.available++;
  }
}
