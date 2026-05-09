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
 *   `✓` green   — success / done
 *   `✗` red     — error
 *   `!` yellow  — warning
 *   `›` dim     — step (indented progress)
 *   `·` dim     — debug
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
 * Render a subsystem name as a dim square-bracketed tag, for example
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

/**
 * Emit a thrown error at the top-level handler. In `--json` mode, writes
 * one `{status: "error", message, exitCode, ...extra}` object to stderr.
 * Otherwise prints `error: <message>` in red. Does not exit; callers
 * decide.
 */
export function emitError(
  message: string,
  exitCode: number,
  extra?: Record<string, unknown>,
): void {
  if (state.json) {
    console.error(JSON.stringify({ status: "error", message, exitCode, ...extra }, null, 2));
    return;
  }
  console.error(red(`  ${bold("error")}: ${message}\n`));
}
