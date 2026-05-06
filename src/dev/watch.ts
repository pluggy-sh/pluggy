/**
 * File watcher for `pluggy dev`. Watches `src/`, every path referenced by
 * `project.resources`, and `project.json`. Events are coalesced by
 * `debounceMs` — a burst of saves yields one `onChange`.
 */

import { existsSync, statSync } from "node:fs";
import { watch } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import { log } from "../logging.ts";
import type { ResolvedProject } from "../project.ts";

export interface WatchOptions {
  /** Debounce interval in milliseconds for file-change events. */
  debounceMs: number;
  /** Called when a rebuild-worthy change is detected (already debounced). */
  onChange: () => Promise<void>;
}

interface WatchTarget {
  path: string;
  recursive: boolean;
  /** If set, only events whose filename matches will trigger onChange. */
  filename?: string;
}

/**
 * Watch the project's source tree and resource paths. Returns a disposer
 * that aborts every watcher and cancels the pending debounce timer.
 */
export function watchProject(project: ResolvedProject, opts: WatchOptions): () => void {
  const controller = new AbortController();

  const targets = collectWatchTargets(project);

  let debounceTimer: NodeJS.Timeout | undefined;
  let disposed = false;

  const fire = (): void => {
    debounceTimer = undefined;
    if (disposed) return;
    Promise.resolve()
      .then(() => opts.onChange())
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`watch: onChange handler threw: ${msg}`);
      });
  };

  const schedule = (): void => {
    if (disposed) return;
    if (debounceTimer !== undefined) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(fire, opts.debounceMs);
    debounceTimer.unref?.();
  };

  for (const target of targets) {
    void consumeWatcher(target, controller.signal, schedule);
  }

  return (): void => {
    if (disposed) return;
    disposed = true;
    if (debounceTimer !== undefined) {
      clearTimeout(debounceTimer);
      debounceTimer = undefined;
    }
    controller.abort();
  };
}

/**
 * Collect watch targets. Source and resource directories are watched
 * recursively; `project.json` is watched file-scoped (parent dir,
 * non-recursive, filename filter) so pluggy's own writes into `bin/`,
 * `dev/`, and `.pluggy-build/` do not trigger rebuild loops.
 *
 * Resource-file mappings are normalized to their parent directory — atomic-
 * rewrite editors evict the file's inode, which kills a file-level watcher;
 * watching the dir survives.
 */
function collectWatchTargets(project: ResolvedProject): WatchTarget[] {
  const targets: WatchTarget[] = [];
  const dirs = new Set<string>();

  const addDir = (path: string): void => {
    if (dirs.has(path)) return;
    dirs.add(path);
    targets.push({ path, recursive: true });
  };

  const srcDir = resolve(project.rootDir, "src");
  if (existsSync(srcDir)) addDir(srcDir);

  if (existsSync(project.projectFile)) {
    targets.push({
      path: dirname(project.projectFile),
      recursive: false,
      filename: basename(project.projectFile),
    });
  }

  const resources = project.resources;
  if (resources !== undefined && resources !== null) {
    for (const value of Object.values(resources)) {
      const absolute = resolve(project.rootDir, value);
      if (!existsSync(absolute)) continue;
      try {
        const info = statSync(absolute);
        addDir(info.isDirectory() ? absolute : dirname(absolute));
      } catch {
        // Path vanished between existsSync and statSync.
      }
    }
  }

  return targets;
}

async function consumeWatcher(
  target: WatchTarget,
  signal: AbortSignal,
  onEvent: () => void,
): Promise<void> {
  try {
    const iter = watch(target.path, { recursive: target.recursive, signal });
    for await (const evt of iter) {
      if (signal.aborted) return;
      if (target.filename !== undefined && evt.filename !== target.filename) continue;
      onEvent();
    }
  } catch (err: unknown) {
    // AbortError is the expected quit path; platforms vary on `.name`.
    if (signal.aborted) return;
    const e = err as { name?: string; code?: string };
    if (e.name === "AbortError" || e.code === "ABORT_ERR") return;
    log.debug(
      `watch: watcher on "${target.path}" failed: ${(err as Error).message ?? String(err)}`,
    );
  }
}
