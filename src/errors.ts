/**
 * Typed errors for the CLI. The top-level handler in `src/index.ts` keys
 * on these classes to choose an exit code, and `--json` output uses the
 * class name as a stable error code.
 *
 * Use `UserError` for problems caused by the invocation itself: bad
 * flags, malformed `project.json`, missing files the user must create,
 * conflicts the user must resolve. Exits 2.
 *
 * Use `RuntimeError` for failures that aren't the user's input: network
 * failures, upstream registry outages, disk-full, permission errors at
 * runtime. Exits 1.
 *
 * Anything else (a bare `Error`, an unexpected `TypeError`) is treated
 * as an internal bug and also exits 1, but with no structured error code.
 * Those paths should be migrated to one of the typed errors below.
 */

export class UserError extends Error {
  override readonly name = "UserError";
  /** Optional structured payload for `--json` mode. */
  readonly extra?: Record<string, unknown>;

  constructor(message: string, extra?: Record<string, unknown>) {
    super(message);
    this.extra = extra;
  }
}

export class RuntimeError extends Error {
  override readonly name = "RuntimeError";
  readonly extra?: Record<string, unknown>;

  constructor(message: string, extra?: Record<string, unknown>) {
    super(message);
    this.extra = extra;
  }
}
