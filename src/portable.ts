/**
 * Cross-platform helpers. Every function here must behave identically on
 * macOS, Linux, and Windows.
 */

import type { ChildProcess } from "node:child_process";
import { copyFile, link, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve, sep } from "node:path";

/**
 * Make `destination` reference the bytes at `source` — hardlink first,
 * byte-copy fallback on EXDEV/EPERM/ENOTSUP/etc. Overwrites `destination`
 * if it exists. Never symlinks (Windows symlinks require admin rights).
 */
export async function linkOrCopy(source: string, destination: string): Promise<void> {
  try {
    await link(source, destination);
    return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      await unlink(destination);
      try {
        await link(source, destination);
        return;
      } catch {
        // Retry also failed — fall through to copy.
      }
    }
    try {
      await copyFile(source, destination);
    } catch (copyErr) {
      const msg = (copyErr as Error).message;
      throw new Error(`linkOrCopy: failed to link or copy ${source} -> ${destination}: ${msg}`);
    }
  }
}

/**
 * Normalize any path string to forward-slash (POSIX) form for persistence
 * in `project.json` / `pluggy.lock`. Output never contains backslashes.
 */
export function toPosixPath(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * Resolve `relative` against the directory of `configFile`, returning an
 * absolute OS-native path. Accepts forward- or back-slashed input.
 */
export function resolveRelativeToConfig(configFile: string, relative: string): string {
  const normalized = toPosixPath(relative);
  if (isAbsolute(normalized)) {
    return resolve(normalized);
  }
  return resolve(dirname(configFile), normalized);
}

export interface ShutdownOptions {
  /** Command written to the child's stdin to request graceful shutdown. */
  gracefulStdin: string;
  /** Milliseconds to wait for graceful exit before `child.kill()`. */
  graceMs: number;
  /** Milliseconds within which a second Ctrl+C triggers immediate force-kill. */
  forceKillWindowMs: number;
}

/**
 * Install a SIGINT handler that orchestrates graceful shutdown of `child`:
 * first Ctrl+C writes `gracefulStdin` and allows up to `graceMs` before
 * `child.kill()`; a second Ctrl+C inside `forceKillWindowMs` SIGKILLs
 * immediately. Returns a disposer that removes the handler.
 */
export function installShutdownHandler(child: ChildProcess, opts: ShutdownOptions): () => void {
  let firstSigintAt = 0;
  let graceTimer: NodeJS.Timeout | undefined;
  let forceWindowTimer: NodeJS.Timeout | undefined;

  const clearGraceTimer = (): void => {
    if (graceTimer !== undefined) {
      clearTimeout(graceTimer);
      graceTimer = undefined;
    }
  };

  const clearForceWindowTimer = (): void => {
    if (forceWindowTimer !== undefined) {
      clearTimeout(forceWindowTimer);
      forceWindowTimer = undefined;
    }
  };

  const onExit = (): void => {
    clearGraceTimer();
    clearForceWindowTimer();
  };

  child.once("exit", onExit);

  const onSigint = (): void => {
    const now = Date.now();
    if (firstSigintAt !== 0 && now - firstSigintAt <= opts.forceKillWindowMs) {
      clearGraceTimer();
      clearForceWindowTimer();
      try {
        child.kill("SIGKILL");
      } catch {
        // Child already dead.
      }
      return;
    }

    firstSigintAt = now;

    clearForceWindowTimer();
    forceWindowTimer = setTimeout(() => {
      firstSigintAt = 0;
      forceWindowTimer = undefined;
    }, opts.forceKillWindowMs);
    forceWindowTimer.unref?.();

    if (child.stdin && !child.stdin.destroyed && child.stdin.writable) {
      try {
        child.stdin.write(opts.gracefulStdin);
      } catch {
        // Stdin may have closed between the check and the write.
      }
    }

    clearGraceTimer();
    graceTimer = setTimeout(() => {
      graceTimer = undefined;
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill();
        } catch {
          // Already dead.
        }
      }
    }, opts.graceMs);
    graceTimer.unref?.();
  };

  process.on("SIGINT", onSigint);

  return (): void => {
    process.removeListener("SIGINT", onSigint);
    child.removeListener("exit", onExit);
    clearGraceTimer();
    clearForceWindowTimer();
  };
}

/**
 * Write `contents` with LF line endings regardless of host OS, so generated
 * build outputs (`server.properties`, `plugin.yml`, ...) are byte-identical
 * across platforms.
 */
export async function writeFileLF(path: string, contents: string): Promise<void> {
  const normalized = contents.includes("\r\n") ? contents.replace(/\r\n/g, "\n") : contents;
  await writeFile(path, normalized, "utf8");
}

/**
 * Join `root` with `relativePath` and assert the result stays under `root`.
 * Use whenever an archive entry name, downloaded path component, or other
 * untrusted input is being written under a directory — a malicious `..` or
 * absolute path otherwise escapes the root (zip-slip). Behaviour is the same
 * on every host: backslashes in the input are rejected up front so a
 * Windows-targeted entry doesn't traverse on Windows but write a literal
 * `\\`-named file on POSIX.
 */
export function safeJoin(root: string, relativePath: string): string {
  if (typeof relativePath !== "string") {
    throw new Error(`safeJoin: relativePath must be a string`);
  }
  // Absolute-path check has to come first: on Windows, `path.resolve("/x")`
  // returns `C:\x` — `\` is the platform separator, so the backslash check
  // below would fire before the absolute one and misreport the error.
  if (isAbsolute(relativePath)) {
    throw new Error(`safeJoin: refusing absolute path: ${JSON.stringify(relativePath)}`);
  }
  if (relativePath.includes("\\")) {
    throw new Error(
      `safeJoin: refusing entry containing backslash: ${JSON.stringify(relativePath)}`,
    );
  }
  const resolvedRoot = resolve(root);
  const candidate = resolve(resolvedRoot, relativePath);
  if (candidate !== resolvedRoot && !candidate.startsWith(resolvedRoot + sep)) {
    throw new Error(`safeJoin: ${JSON.stringify(relativePath)} escapes ${JSON.stringify(root)}`);
  }
  return candidate;
}
