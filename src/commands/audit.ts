import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import process from "node:process";

import { Command } from "commander";

import { cachedJarPathForEntry } from "../cache/dependency-paths.ts";
import { UserError } from "../errors.ts";
import { type LockfileEntry, readLock } from "../lockfile.ts";
import { bold, dim, emit, emitErr, log, red } from "../logging.ts";
import { projectStartDir, resolveWorkspaceContext } from "../workspace.ts";

import { doInstall } from "./install.ts";

export interface AuditOptions {
  /** Re-download entries that are missing or tampered, then re-verify. */
  fix?: boolean;
  /** Global `--project <path>` flag: resolve the project from this file instead of cwd. */
  project?: string;
  cwd?: string;
}

export interface AuditRow {
  name: string;
  /** "ok" = bytes match. "tampered" = bytes hash to something else. "missing" = jar not in cache. "skipped" = workspace dep, no cache. */
  status: "ok" | "tampered" | "missing" | "skipped";
  expected?: string;
  actual?: string;
  jarPath?: string;
}

export interface AuditResult {
  ok: boolean;
  exitCode: 0 | 1;
  rows: AuditRow[];
  /** Counts by status for the summary line. */
  summary: { ok: number; tampered: number; missing: number; skipped: number };
}

/** Hash every cached jar against the lockfile's recorded integrity. */
export async function doAudit(opts: AuditOptions = {}): Promise<AuditResult> {
  const cwd = opts.cwd ?? process.cwd();
  const context = resolveWorkspaceContext(projectStartDir(opts.project, cwd));
  if (context === undefined) {
    throw new UserError("No pluggy project found. Run this from inside a project directory.", {
      code: "E_AUDIT_NO_PROJECT",
      hint: "Run `pluggy init` to create a new project, or cd into an existing one.",
    });
  }

  const lock = readLock(context.root.rootDir);
  if (lock === null) {
    throw new UserError("No pluggy.lock found. Run pluggy install first.", {
      code: "E_AUDIT_NO_LOCKFILE",
      hint: "Run `pluggy install` to generate the lockfile.",
    });
  }

  const names = Object.keys(lock.entries).sort();
  const audit = async (): Promise<AuditRow[]> => {
    const out: AuditRow[] = [];
    for (const name of names) out.push(await checkOne(name, lock.entries[name]));
    return out;
  };

  let rows = await audit();
  if (opts.fix === true && rows.some((r) => r.status !== "ok" && r.status !== "skipped")) {
    // `install` re-downloads anything absent and replaces bytes that don't
    // match the lockfile, so it is the repair path for both states.
    log.step("Re-downloading unverified dependencies…");
    await doInstall({ project: opts.project, cwd });
    rows = await audit();
  }

  const summary = {
    ok: rows.filter((r) => r.status === "ok").length,
    tampered: rows.filter((r) => r.status === "tampered").length,
    missing: rows.filter((r) => r.status === "missing").length,
    skipped: rows.filter((r) => r.status === "skipped").length,
  };
  // "Could not verify" is not "verified": a cold cache (every CI runner)
  // would otherwise pass this gate having hashed nothing.
  const ok = summary.tampered === 0 && summary.missing === 0;
  const exitCode: 0 | 1 = ok ? 0 : 1;

  const result: AuditResult = { ok, exitCode, rows, summary };
  emitAuditResult(result);
  return result;
}

async function checkOne(name: string, entry: LockfileEntry): Promise<AuditRow> {
  const jarPath = cachedJarPathForEntry(entry);
  if (jarPath === undefined) {
    return { name, status: "skipped" };
  }
  if (!(await fileExists(jarPath))) {
    return { name, status: "missing", expected: entry.integrity, jarPath };
  }
  const bytes = await readFile(jarPath);
  const actual = `sha256-${createHash("sha256").update(bytes).digest("hex")}`;
  if (actual === entry.integrity) {
    return { name, status: "ok", expected: entry.integrity, actual, jarPath };
  }
  return { name, status: "tampered", expected: entry.integrity, actual, jarPath };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function emitAuditResult(result: AuditResult): void {
  const payload = {
    status: result.ok ? "success" : "error",
    ok: result.ok,
    summary: result.summary,
    rows: result.rows,
  };
  const printHuman = (): void => {
    const tampered = result.rows.filter((r) => r.status === "tampered");
    const missing = result.rows.filter((r) => r.status === "missing");

    if (tampered.length > 0) {
      log.heading("Tampered");
      for (const row of tampered) {
        log.error(`${bold(row.name)}`);
        log.info(`  ${dim("expected:")} ${row.expected}`);
        log.info(`  ${dim("actual:  ")} ${row.actual}`);
        if (row.jarPath !== undefined) log.info(`  ${dim("jar:     ")} ${row.jarPath}`);
      }
      log.info(
        dim("Run `pluggy install` to re-download; it detects tampering and heals the cache."),
      );
    }

    if (missing.length > 0) {
      log.heading("Unverified");
      for (const row of missing) {
        log.step(`${row.name} ${dim("(not cached)")}`);
      }
      log.info(dim("Run `pluggy audit --fix` to download and verify them."));
    }

    const skipped =
      result.summary.skipped > 0 ? `, ${result.summary.skipped} skipped (workspace)` : "";
    log.info("");
    if (result.summary.tampered > 0) {
      const unverified = result.summary.missing > 0 ? `, ${result.summary.missing} unverified` : "";
      log.info(
        red(`${result.summary.tampered} tampered`) +
          `, ${result.summary.ok} verified${unverified}${skipped}`,
      );
    } else if (result.summary.missing > 0) {
      log.info(
        red(`${result.summary.missing} unverified (not cached)`) +
          `, ${result.summary.ok} verified${skipped}`,
      );
    } else if (result.rows.length === 0) {
      log.success("no dependencies to verify");
    } else {
      log.success(`${result.summary.ok} verified${skipped}`);
    }
  };

  if (result.ok) emit(payload, printHuman);
  else emitErr(payload, printHuman);
}

export function auditCommand(): Command {
  return new Command("audit")
    .description("Verify cached dependency jars against pluggy.lock integrity hashes.")
    .option("--fix", "Re-download unverified or tampered jars, then verify again.")
    .addHelpText(
      "after",
      "\nAudit exits 0 only when every locked dependency was hashed and matched. A dependency that isn't cached counts as unverified, not as passing.",
    )
    .action(async function action(this: Command, options) {
      const result = await doAudit({
        fix: options.fix === true,
        project: this.optsWithGlobals().project,
      });
      if (result.exitCode !== 0) process.exit(result.exitCode);
    });
}
