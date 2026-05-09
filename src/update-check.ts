/**
 * Background check for new pluggy releases.
 *
 * Reads/writes a small state file with the most recent known release tag
 * and the time we last checked. Network fetch is fire-and-forget; the
 * banner shown to the user is always derived from the *cached* result, so
 * it never blocks the current command. Suppressed when output is
 * non-interactive (`--json`, CI, no TTY) or explicitly disabled via
 * `PLUGGY_NO_UPDATE_CHECK=1`.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";

import { bold, brightBlue, dim } from "./logging.ts";
import { getCachePath, getStatePath } from "./project.ts";

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 2000;

interface UpdateState {
  latestVersion: string;
  lastCheckedAt: string;
}

export interface UpdateCheckOptions {
  /** GitHub `owner/repo` slug to query. */
  repository: string;
  /** Current pluggy version (without leading `v`). */
  currentVersion: string;
  /** True when the command is emitting JSON; suppresses the banner. */
  json?: boolean;
  /** Override now() for tests. */
  now?: () => Date;
  /** Override the state file location for tests. */
  stateFile?: string;
}

export interface UpdateCheckHandle {
  /** Print the banner to stderr if the cached state shows a newer version. */
  printBannerIfOutdated: () => void;
  /** Abort any in-flight fetch so the process can exit promptly. */
  dispose: () => void;
}

/** Default location of the state file. */
export function getStateFilePath(): string {
  return join(getStatePath(), "update-check.json");
}

/**
 * One-shot migration: pluggy <= 0.x kept `update-check.json` inside the
 * cache directory, where it would have been wiped by `pluggy cache clean`.
 * On first read after upgrade, move it under the state directory.
 */
async function migrateLegacyState(stateFile: string): Promise<void> {
  const legacy = join(getCachePath(), "update-check.json");
  if (!existsSync(legacy) || existsSync(stateFile)) return;
  try {
    await mkdir(dirname(stateFile), { recursive: true });
    await rename(legacy, stateFile);
  } catch {
    // Best-effort: a failed migration just means the next fetch repopulates
    // the new path. Don't block the user's command on this.
  }
}

/**
 * Compare two semver-ish version strings (for example, `0.2.0`, `v0.2.1-beta`).
 * Returns -1 if `a < b`, 0 if equal, 1 if `a > b`. Pre-release suffixes
 * are ignored for the comparison; close enough for "you are outdated".
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const parse = (v: string): number[] => {
    const stripped = v.replace(/^v/, "").split(/[-+]/, 1)[0] ?? "0.0.0";
    return stripped.split(".").map((part) => {
      const n = Number.parseInt(part, 10);
      return Number.isFinite(n) ? n : 0;
    });
  };
  const av = parse(a);
  const bv = parse(b);
  const len = Math.max(av.length, bv.length);
  for (let i = 0; i < len; i++) {
    const x = av[i] ?? 0;
    const y = bv[i] ?? 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

/** Whether the update check should be skipped entirely for this run. */
function isSuppressed(opts: UpdateCheckOptions): boolean {
  if (opts.json === true) return true;
  if (process.env.PLUGGY_NO_UPDATE_CHECK === "1") return true;
  if (process.env.CI !== undefined && process.env.CI !== "" && process.env.CI !== "false") {
    return true;
  }
  if (process.stderr.isTTY !== true) return true;
  // Dev builds (CLI_VERSION not yet stamped by release.yml); nothing to compare against.
  if (opts.currentVersion === "0.0.0" || opts.currentVersion === "") return true;
  return false;
}

async function readState(path: string): Promise<UpdateState | undefined> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<UpdateState>;
    if (typeof parsed.latestVersion !== "string" || typeof parsed.lastCheckedAt !== "string") {
      return undefined;
    }
    return { latestVersion: parsed.latestVersion, lastCheckedAt: parsed.lastCheckedAt };
  } catch {
    return undefined;
  }
}

async function writeState(path: string, state: UpdateState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(state, null, 2), "utf8");
}

interface ReleaseResponse {
  tag_name?: string;
  message?: string;
}

/**
 * Kick off the version check. Reads cached state immediately so the
 * caller can render a banner without waiting on the network. If the
 * cache is stale, a background fetch updates it for the next run.
 *
 * The returned handle owns an `AbortController` for the in-flight
 * request: call `dispose()` from a `beforeExit` hook so the process
 * doesn't linger on a slow socket.
 */
export async function startUpdateCheck(opts: UpdateCheckOptions): Promise<UpdateCheckHandle> {
  if (isSuppressed(opts)) {
    return { printBannerIfOutdated: () => {}, dispose: () => {} };
  }

  const now = opts.now ?? (() => new Date());
  const stateFile = opts.stateFile ?? getStateFilePath();
  if (opts.stateFile === undefined) await migrateLegacyState(stateFile);
  const cached = await readState(stateFile);

  const stale =
    cached === undefined ||
    now().getTime() - new Date(cached.lastCheckedAt).getTime() > CHECK_INTERVAL_MS;

  let aborted = false;
  const controller = new AbortController();
  let pending: Promise<void> | undefined;

  if (stale) {
    pending = (async () => {
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      try {
        const res = await fetch(`https://api.github.com/repos/${opts.repository}/releases/latest`, {
          headers: { Accept: "application/vnd.github+json" },
          signal: controller.signal,
        });
        if (!res.ok) return;
        const data = (await res.json()) as ReleaseResponse;
        if (typeof data.tag_name !== "string") return;
        await writeState(stateFile, {
          latestVersion: data.tag_name.replace(/^v/, ""),
          lastCheckedAt: now().toISOString(),
        });
      } catch {
        // Network errors, abort, JSON parse: all fine to ignore. We'll retry next run.
      } finally {
        clearTimeout(timer);
      }
    })();
    // Swallow rejections so the unhandled-rejection handler never fires.
    pending.catch(() => {});
  }

  return {
    printBannerIfOutdated: () => {
      if (cached === undefined) return;
      if (compareVersions(opts.currentVersion, cached.latestVersion) >= 0) return;
      const arrow = dim("→");
      const msg = `${dim("✦")} pluggy ${brightBlue(cached.latestVersion)} available ${arrow} you have ${dim(opts.currentVersion)}. Run ${bold("pluggy upgrade")}.`;
      process.stderr.write(`${msg}\n`);
    },
    dispose: () => {
      if (aborted) return;
      aborted = true;
      controller.abort();
    },
  };
}

/**
 * Returns the most recently cached latest version, if any. Used by
 * `pluggy doctor` so it can flag an outdated CLI without firing its own
 * network request.
 */
export async function getCachedLatestVersion(stateFile?: string): Promise<string | undefined> {
  const state = await readState(stateFile ?? getStateFilePath());
  return state?.latestVersion;
}
