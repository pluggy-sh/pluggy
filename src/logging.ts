/**
 * Terminal logging built on picocolors. Color and verbose state are set
 * once at startup via `initLogging`, before any command runs. Reading
 * `process.argv` at module-load time is fragile for tests and library
 * embedding, so we defer it.
 *
 * `emit` is the single output backbone: every command-layer success or
 * error result goes through it, and it routes between human-readable
 * formatting and `--json` mode based on the mode set at startup.
 */

import process from "node:process";
import pc from "picocolors";

interface LoggingState {
  noColor: boolean;
  verbose: boolean;
  json: boolean;
}

const state: LoggingState = {
  noColor: false,
  verbose: false,
  json: false,
};

export interface InitLoggingOptions {
  /** Disable ANSI color output. Mirrors `--no-color` and `NO_COLOR`. */
  noColor?: boolean;
  /** Enable `log.debug`. Mirrors `-v` / `--verbose` and `DEBUG`. */
  verbose?: boolean;
  /** Switch `emit` into machine-readable JSON mode. Mirrors `--json`. */
  json?: boolean;
}

/**
 * Wire logging to the parsed global options. Call once at startup, after
 * commander has parsed argv. Defaults to no-color and non-verbose, so
 * uninitialized callers see safe output.
 *
 * The `noColor` and `verbose` flags OR with the `NO_COLOR` and `DEBUG`
 * environment variables: either the flag or the env var is enough to flip
 * the behaviour. (Tests pass `noColor: true` directly; callers that want
 * to suppress the env-var fallback should clear those env vars first.)
 */
export function initLogging(opts: InitLoggingOptions): void {
  state.noColor = opts.noColor === true || process.env.NO_COLOR !== undefined;
  state.verbose = opts.verbose === true || process.env.DEBUG !== undefined;
  state.json = opts.json ?? false;
}

/** True when `--json` was set. Lets commands skip work that only matters for human output. */
export function isJsonMode(): boolean {
  return state.json;
}

function color(fn: (s: string) => string): (s: string) => string {
  return (s) => (state.noColor ? s : fn(s));
}

export const bold = color(pc.bold);
export const dim = color(pc.dim);
export const red = color(pc.red);
export const green = color(pc.green);
export const yellow = color(pc.yellow);
export const blue = color(pc.blue);
export const brightBlue = color(pc.blueBright);

/**
 * Console logger. Output is silent in `--json` mode so the JSON envelope
 * stays the only thing on stdout.
 *
 * Glyph budget:
 *   `✓` green   success / done
 *   `✗` red     error
 *   `!` yellow  warning
 *   `›` dim     step (indented progress)
 *   `·` dim     debug
 *
 * Compose with `tag(scope)` to label which subsystem produced the line:
 * `log.step(`${tag("dev")} change detected`)`.
 */
export const log = {
  /** Section heading. Adds a blank line above and bolds the text. */
  heading(msg: string): void {
    if (state.json) return;
    console.log(`\n${bold(msg)}`);
  },

  /** Plain informational line. */
  info(msg: string): void {
    if (state.json) return;
    console.log(msg);
  },

  /** Indented progress line. Use for sub-steps under a heading or task. */
  step(msg: string): void {
    if (state.json) return;
    console.log(`  ${dim("›")} ${msg}`);
  },

  /** Debug-only line. Hidden unless `-v` / `--verbose` / `DEBUG`. */
  debug(msg: string): void {
    if (state.json) return;
    if (state.verbose) console.log(dim(`  · ${msg}`));
  },

  /** Non-fatal warning. */
  warn(msg: string): void {
    if (state.json) return;
    console.warn(`${yellow("!")} ${msg}`);
  },

  /** Recoverable error (the command may continue). */
  error(msg: string): void {
    if (state.json) return;
    console.error(`${red("✗")} ${msg}`);
  },

  /** Fatal error. Same render as `error`; reserved for command-aborting failures. */
  critical(msg: string): void {
    if (state.json) return;
    console.error(`${red("✗")} ${msg}`);
  },

  /** Success / completion line. */
  success(msg: string): void {
    if (state.json) return;
    console.log(`${green("✓")} ${msg}`);
  },
};

/**
 * Render a subsystem name as a dim square-bracketed tag, e.g.
 * `[dev]`. Use in front of a `log.step` / `log.info` line so the user
 * sees who produced the message without baking the prefix into every
 * call site.
 */
export function tag(scope: string): string {
  return dim(`[${scope}]`);
}

/**
 * Emit a final command result. In `--json` mode, writes `payload` to
 * stdout as one JSON object. Otherwise calls `humanFn` to print
 * human-friendly output. Caller owns the payload shape, including the
 * `status` field if any. Commands funnel every terminal write through
 * `emit` or `emitErr` rather than branching on `opts.json` in line.
 */
export function emit(payload: Record<string, unknown>, humanFn: () => void): void {
  if (state.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  humanFn();
}

/**
 * Same as `emit`, but routes JSON to stderr and uses `humanFn` for the
 * human path. Use for partial failures where exit code is non-zero but
 * the result envelope is still structured.
 */
export function emitErr(payload: Record<string, unknown>, humanFn: () => void): void {
  if (state.json) {
    console.error(JSON.stringify(payload, null, 2));
    return;
  }
  humanFn();
}

/** Structured error fields rendered by `emitError`. */
export interface EmitErrorDetails {
  /** Stable error code (`E_LOCKFILE_PARSE`, `E_PLATFORM_UNKNOWN`, …). */
  code?: string;
  /** Single-line follow-up shown dim under the main message. */
  hint?: string;
  /** Pre-formatted source location, e.g. `at /path/project.json:12 (/compatibility)`. */
  source?: string;
  /** Free-form structured payload included verbatim in JSON output. */
  context?: Record<string, unknown>;
  /** Cause chain, proximate to root. Each entry rendered on its own dim line. */
  causes?: string[];
}

/**
 * Emit a thrown error at the top-level handler. In `--json` mode, writes
 * one structured object to stderr. Otherwise prints
 * `error: <message>` in red, followed by dim hint / source / cause
 * lines. Does not exit; callers decide.
 */
export function emitError(message: string, exitCode: number, details: EmitErrorDetails = {}): void {
  if (state.json) {
    const payload: Record<string, unknown> = { status: "error", exitCode, message };
    if (details.code !== undefined) payload.code = details.code;
    if (details.hint !== undefined) payload.hint = details.hint;
    if (details.source !== undefined) payload.source = details.source;
    if (details.causes !== undefined && details.causes.length > 0) payload.causes = details.causes;
    if (details.context !== undefined) {
      for (const [key, value] of Object.entries(details.context)) {
        if (!(key in payload)) payload[key] = value;
      }
    }
    console.error(JSON.stringify(payload, null, 2));
    return;
  }

  const prefix = details.code !== undefined ? ` ${dim(`[${details.code}]`)}` : "";
  console.error(`\n${red(bold("error"))}${prefix}: ${message}`);
  if (details.hint !== undefined) console.error(`  ${dim("hint:")} ${details.hint}`);
  if (details.source !== undefined) console.error(`  ${dim(details.source)}`);
  for (const cause of details.causes ?? []) {
    console.error(`  ${dim(`caused by: ${cause}`)}`);
  }
  console.error("");
}
