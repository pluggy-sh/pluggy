import { existsSync, realpathSync, statSync } from "node:fs";
import { delimiter, join, sep } from "node:path";

/**
 * How the running pluggy binary got onto the user's machine. Drives
 * `pluggy upgrade`'s self-update guard and is surfaced in `pluggy doctor`
 * so bug reports identify the install path without the user having to dig.
 */
export type InstallMethod = "homebrew" | "scoop" | "manual" | "unknown";

export interface InstallInfo {
  method: InstallMethod;
  /** Path after symlink/junction resolution. */
  resolvedPath: string;
  /** Original `process.execPath`, before resolution. */
  rawPath: string;
}

/** Lower-case, forward-slashed copy of `path` for cross-platform pattern matching. */
function normalize(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}

function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Inspect a binary path and classify how it was installed. Falls back to
 * `unknown` when no rule matches; callers should treat `unknown` as
 * non-managed (i.e. allow self-update) since the install script's default
 * locations are the `manual` rules below.
 */
export function detectInstallMethod(execPath: string = process.execPath): InstallInfo {
  const resolved = safeRealpath(execPath);
  const norm = normalize(resolved);

  // Homebrew binaries always live under a Cellar/<name>/ subtree, regardless
  // of prefix (/opt/homebrew on Apple Silicon, /usr/local on Intel macOS,
  // /home/linuxbrew/.linuxbrew on Linuxbrew).
  if (/\/cellar\/pluggy\//.test(norm)) {
    return { method: "homebrew", resolvedPath: resolved, rawPath: execPath };
  }

  // Scoop installs under <userprofile>/scoop/apps/<name>/<version>/.
  if (/\/scoop\/apps\/pluggy\//.test(norm)) {
    return { method: "scoop", resolvedPath: resolved, rawPath: execPath };
  }

  // Curl/iwr install script default locations.
  if (/\/\.pluggy\/bin\//.test(norm) || /\/programs\/pluggy\//.test(norm)) {
    return { method: "manual", resolvedPath: resolved, rawPath: execPath };
  }

  return { method: "unknown", resolvedPath: resolved, rawPath: execPath };
}

/** Human-readable label for `--json` consumers and doctor output. */
export function describeInstallMethod(method: InstallMethod): string {
  switch (method) {
    case "homebrew":
      return "Homebrew";
    case "scoop":
      return "Scoop";
    case "manual":
      return "install script";
    case "unknown":
      return "unknown";
  }
}

/** The command a user should run to upgrade a managed install, or `undefined` for self-update. */
export function upgradeCommandFor(method: InstallMethod): string | undefined {
  switch (method) {
    case "homebrew":
      return "brew upgrade pluggy";
    case "scoop":
      return "scoop update pluggy";
    case "manual":
    case "unknown":
      return undefined;
  }
}

/**
 * Walk every directory on PATH looking for additional pluggy executables.
 * Returns resolved (symlinks followed) paths, excluding `currentResolvedPath`
 * and any duplicates that resolve to the same file. Used by `pluggy doctor`
 * to warn when curl-installed and brew-installed pluggy binaries are
 * shadowing each other.
 */
export function findOtherInstalls(currentResolvedPath: string): string[] {
  const PATH = process.env.PATH ?? "";
  if (PATH.length === 0) return [];

  const exeName = process.platform === "win32" ? "pluggy.exe" : "pluggy";
  const seen = new Set<string>([safeRealpath(currentResolvedPath)]);
  const others: string[] = [];

  for (const dir of PATH.split(delimiter)) {
    if (dir.length === 0) continue;
    const candidate = join(dir, exeName);
    if (!existsSync(candidate)) continue;
    try {
      if (!statSync(candidate).isFile()) continue;
    } catch {
      continue;
    }
    const resolved = safeRealpath(candidate);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    others.push(resolved);
  }

  return others;
}

/** Trivially-mockable PATH separator export for tests on the wrong host OS. */
export const PATH_SEP = sep;
