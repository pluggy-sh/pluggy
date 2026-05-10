import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import process from "node:process";

import { Command } from "commander";

import { cachedJarPathForEntry } from "../cache/dependency-paths.ts";
import { UserError } from "../errors.ts";
import { type LockfileEntry, readLock } from "../lockfile.ts";
import { bold, dim, emit, emitErr, log, red } from "../logging.ts";
import { resolveWorkspaceContext } from "../workspace.ts";

export interface AuditOptions {
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
  const context = resolveWorkspaceContext(cwd);
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
  const rows: AuditRow[] = [];
  for (const name of names) {
    rows.push(await checkOne(name, lock.entries[name]));
  }

  const summary = {
    ok: rows.filter((r) => r.status === "ok").length,
    tampered: rows.filter((r) => r.status === "tampered").length,
    missing: rows.filter((r) => r.status === "missing").length,
    skipped: rows.filter((r) => r.status === "skipped").length,
  };
  const ok = summary.tampered === 0;
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
    }

    if (missing.length > 0) {
      log.heading("Not cached");
      for (const row of missing) {
        log.step(`${row.name} ${dim("(run pluggy install to populate)")}`);
      }
    }

    log.info("");
    if (result.ok) {
      log.success(
        `${result.summary.ok} verified${result.summary.skipped > 0 ? `, ${result.summary.skipped} skipped (workspace)` : ""}${result.summary.missing > 0 ? `, ${result.summary.missing} not cached` : ""}`,
      );
    } else {
      log.info(red(`${result.summary.tampered} tampered`) + ", " + `${result.summary.ok} ok`);
    }
  };

  if (result.ok) emit(payload, printHuman);
  else emitErr(payload, printHuman);
}

export function auditCommand(): Command {
  return new Command("audit")
    .description("Verify cached dependency jars against pluggy.lock integrity hashes.")
    .action(async function action(this: Command) {
      const result = await doAudit();
      if (result.exitCode !== 0) process.exit(result.exitCode);
    });
}
