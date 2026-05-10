import process from "node:process";

import { Command } from "commander";

import { UserError } from "../errors.ts";
import { type Lockfile, type LockfileEntry, readLock } from "../lockfile.ts";
import { bold, dim, emit, log, yellow } from "../logging.ts";
import { DEFAULT_MAVEN_REGISTRIES, registryUrl } from "../registry.ts";
import { getLatestMavenVersion } from "../resolver/maven.ts";
import { getLatestModrinthVersion } from "../resolver/modrinth.ts";
import { compareVersions } from "../update-check.ts";
import { resolveWorkspaceContext, type WorkspaceContext } from "../workspace.ts";

export interface OutdatedOptions {
  beta?: boolean;
  cwd?: string;
}

export interface OutdatedRow {
  name: string;
  source: "modrinth" | "maven" | "file" | "workspace";
  current: string;
  latest?: string;
  diff: "major" | "minor" | "patch" | "same" | "unknown" | "error";
  error?: string;
  /** True for entries the user declared directly. */
  topLevel: boolean;
}

export interface OutdatedResult {
  rows: OutdatedRow[];
  /** Count of `topLevel` rows where `diff` is one of major/minor/patch. */
  outdatedCount: number;
}

/** Resolve every lockfile entry's latest upstream version and compare. */
export async function doOutdated(opts: OutdatedOptions = {}): Promise<OutdatedResult> {
  const cwd = opts.cwd ?? process.cwd();
  const context = resolveWorkspaceContext(cwd);
  if (context === undefined) {
    throw new UserError("No pluggy project found. Run this from inside a project directory.", {
      code: "E_OUTDATED_NO_PROJECT",
      hint: "Run `pluggy init` to create a new project, or cd into an existing one.",
    });
  }

  const lock = readLock(context.root.rootDir);
  if (lock === null) {
    throw new UserError("No pluggy.lock found. Run pluggy install first.", {
      code: "E_OUTDATED_NO_LOCKFILE",
      hint: "Run `pluggy install` to generate the lockfile.",
    });
  }

  const registries = unionRegistries(context);
  const includePrerelease = opts.beta === true;

  const names = Object.keys(lock.entries).sort();
  const rows = await Promise.all(
    names.map((name) => checkOne(name, lock, registries, includePrerelease)),
  );

  const outdatedCount = rows.filter(
    (r) => r.topLevel && (r.diff === "major" || r.diff === "minor" || r.diff === "patch"),
  ).length;

  const result: OutdatedResult = { rows, outdatedCount };
  emitOutdatedResult(result);
  return result;
}

async function checkOne(
  name: string,
  lock: Lockfile,
  registries: string[],
  includePrerelease: boolean,
): Promise<OutdatedRow> {
  const entry = lock.entries[name];
  const topLevel = entry.declaredBy.length > 0;
  const current = entry.resolvedVersion;
  const sourceKind = entry.source.kind;

  if (sourceKind === "file" || sourceKind === "workspace") {
    return { name, source: sourceKind, current, diff: "unknown", topLevel };
  }

  try {
    const latest = await fetchLatest(entry, registries, includePrerelease);
    if (latest === undefined) {
      return { name, source: sourceKind, current, diff: "unknown", topLevel };
    }
    const diff = classifyDiff(current, latest);
    return { name, source: sourceKind, current, latest, diff, topLevel };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { name, source: sourceKind, current, diff: "error", error: message, topLevel };
  }
}

async function fetchLatest(
  entry: LockfileEntry,
  registries: string[],
  includePrerelease: boolean,
): Promise<string | undefined> {
  switch (entry.source.kind) {
    case "modrinth":
      return getLatestModrinthVersion(entry.source.slug, includePrerelease);
    case "maven":
      return getLatestMavenVersion(entry.source.groupId, entry.source.artifactId, registries);
    default:
      return undefined;
  }
}

function classifyDiff(current: string, latest: string): OutdatedRow["diff"] {
  if (current === latest) return "same";
  const cmp = compareVersions(current, latest);
  if (cmp >= 0) return "same";
  const cur = parseSemverParts(current);
  const lat = parseSemverParts(latest);
  if (cur === undefined || lat === undefined) return "unknown";
  if (lat[0] > cur[0]) return "major";
  if (lat[1] > cur[1]) return "minor";
  return "patch";
}

function parseSemverParts(v: string): [number, number, number] | undefined {
  const stripped = v.replace(/^v/, "").split(/[-+]/, 1)[0] ?? "";
  const parts = stripped.split(".").map((p) => Number.parseInt(p, 10));
  if (parts.length < 1 || parts.some((n) => !Number.isFinite(n))) return undefined;
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

function unionRegistries(context: WorkspaceContext): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (url: string): void => {
    const key = url.endsWith("/") ? url.slice(0, -1) : url;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(url);
  };
  for (const r of context.root.registries ?? []) push(registryUrl(r));
  for (const ws of context.workspaces) {
    for (const r of ws.project.registries ?? []) push(registryUrl(r));
  }
  for (const url of DEFAULT_MAVEN_REGISTRIES) push(url);
  return out;
}

function emitOutdatedResult(result: OutdatedResult): void {
  emit(
    {
      status: "success",
      outdatedCount: result.outdatedCount,
      rows: result.rows,
    },
    () => {
      const stale = result.rows.filter(
        (r) => r.diff === "major" || r.diff === "minor" || r.diff === "patch",
      );
      if (stale.length === 0) {
        log.success(`All ${result.rows.length} dependencies up to date`);
        return;
      }

      const nameWidth = Math.max(...stale.map((r) => r.name.length), 4);
      const curWidth = Math.max(...stale.map((r) => r.current.length), 7);
      const latestWidth = Math.max(...stale.map((r) => (r.latest ?? "?").length), 6);

      log.heading("Outdated");
      log.info(
        `  ${pad("Name", nameWidth)}  ${pad("Current", curWidth)}  ${pad("Latest", latestWidth)}  ${dim("Source")}`,
      );
      for (const row of stale) {
        const latest = row.latest ?? "?";
        const change = row.diff === "major" ? yellow(latest) : latest;
        const sourceTag = row.topLevel ? row.source : `${row.source} (transitive)`;
        log.info(
          `  ${pad(bold(row.name), nameWidth, row.name)}  ${pad(row.current, curWidth)}  ${pad(change, latestWidth, latest)}  ${dim(sourceTag)}`,
        );
      }
      const errs = result.rows.filter((r) => r.diff === "error");
      if (errs.length > 0) {
        log.info("");
        for (const row of errs) {
          log.warn(`${row.name}: ${row.error ?? "lookup failed"}`);
        }
      }
      log.info("");
      log.info(`${result.outdatedCount} top-level outdated, ${stale.length} entries total stale.`);
    },
  );
}

/** Pad `s` to `width` columns, measuring against `plain` so ANSI color escapes don't count. */
function pad(s: string, width: number, plain?: string): string {
  const measured = (plain ?? s).length;
  return s + " ".repeat(Math.max(0, width - measured));
}

export function outdatedCommand(): Command {
  return new Command("outdated")
    .description("Show locked dependencies that have a newer upstream version.")
    .option("--beta", "Include pre-release versions when computing latest.")
    .action(async function action(this: Command, options) {
      await doOutdated({ beta: options.beta === true });
    });
}
