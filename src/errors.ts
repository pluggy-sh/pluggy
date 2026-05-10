/**
 * Typed errors for the CLI. Carry enough structure that the top-level
 * handler can render a useful human message *and* a stable, scriptable
 * JSON envelope from the same throw site.
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
 * as an internal bug and also exits 1, but with no structured error
 * code. Those paths should be migrated to one of the typed errors below.
 *
 * Beyond the message, errors carry:
 *   - `code`: stable identifier for scripting. Conventionally `E_<AREA>_<KIND>`.
 *   - `hint`: one-line follow-up shown dim under the message.
 *   - `source`: file (and optional line/pointer) the error refers to,
 *     so JSON-validation errors can point the user at the offending key.
 *   - `context`: free-form structured payload that goes verbatim into
 *     the JSON envelope. Use for graphs (cycles, conflict pairs) or
 *     identifiers a script might want to consume.
 *   - `cause`: the underlying error in a chain (`new UserError(msg, { cause: err })`).
 *     Renders as a dim `caused by:` line in human mode.
 */

/** Pointer into a file the error refers to. */
export interface SourceLoc {
  /** Absolute path (or URL) to the file. */
  file: string;
  /** 1-based line number, when known. */
  line?: number;
  /** 1-based column number, when known. */
  column?: number;
  /** JSON Pointer (`/foo/bar`) or dotted path into the document, when applicable. */
  pointer?: string;
}

/** Structured fields any typed error can carry. */
export interface ErrorDetails {
  /** Stable identifier for scripting. Convention: `E_<AREA>_<KIND>`. */
  code?: string;
  /** Single-line suggestion shown dim under the message. */
  hint?: string;
  /** Pointer to the file (and location) the error is about. */
  source?: SourceLoc;
  /** Free-form structured payload included verbatim in JSON output. */
  context?: Record<string, unknown>;
  /** Underlying error in a chain. Rendered as a `caused by:` line. */
  cause?: unknown;
}

abstract class TypedError extends Error {
  readonly code?: string;
  readonly hint?: string;
  readonly source?: SourceLoc;
  readonly context?: Record<string, unknown>;
  // `cause` is also exposed by ES2022's built-in `Error.cause`; we mirror it
  // so older runtimes and our own renderer can reach it uniformly.
  override readonly cause?: unknown;

  constructor(message: string, details?: ErrorDetails) {
    super(message);
    if (details === undefined) return;
    this.code = details.code;
    this.hint = details.hint;
    this.source = details.source;
    this.context = details.context;
    this.cause = details.cause;
  }
}

export class UserError extends TypedError {
  override readonly name = "UserError";
}

export class RuntimeError extends TypedError {
  override readonly name = "RuntimeError";
}

/** Type guard so `instanceof` checks survive the abstract base. */
export function isTypedError(err: unknown): err is UserError | RuntimeError {
  return err instanceof UserError || err instanceof RuntimeError;
}

/**
 * Render a one-line `at <file>:<line>:<col> (<pointer>)` summary for a
 * `SourceLoc`, omitting fields that aren't set. Returns `undefined` for
 * a missing or empty location.
 */
export function formatSource(loc: SourceLoc | undefined): string | undefined {
  if (loc === undefined) return undefined;
  let out = `at ${loc.file}`;
  if (loc.line !== undefined) {
    out += `:${loc.line}`;
    if (loc.column !== undefined) out += `:${loc.column}`;
  }
  if (loc.pointer !== undefined && loc.pointer.length > 0) {
    out += ` (${loc.pointer})`;
  }
  return out;
}

/**
 * Walk the `cause` chain, returning each link's message in order from
 * proximate to root. Stops at non-Error causes (rendered as their
 * `String()` form) and at a depth limit so a self-referential chain
 * can't loop.
 */
export function causeMessages(err: unknown, max = 8): string[] {
  const out: string[] = [];
  let current: unknown = err;
  let depth = 0;
  while (current !== undefined && depth < max) {
    const next: unknown = (current as { cause?: unknown } | null)?.cause;
    if (next === undefined || next === null) break;
    if (next instanceof Error) out.push(next.message);
    else if (typeof next === "string") out.push(next);
    else out.push(JSON.stringify(next));
    current = next;
    depth++;
  }
  return out;
}
