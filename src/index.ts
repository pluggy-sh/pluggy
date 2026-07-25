#!/usr/bin/env bun
import process from "node:process";

import { Command, InvalidArgumentError } from "commander";

import { causeMessages, formatSource, isTypedError, UserError } from "./errors.ts";
import { dim, emitError, initLogging } from "./logging.ts";
import { createProgram, REPOSITORY } from "./program.ts";
import { startUpdateCheck } from "./update-check.ts";
import { CLI_VERSION } from "./version.ts";

// Side-effect import: platform providers self-register via createPlatform.
import "./platform/index.ts";

const program = createProgram();

// Pre-parse the global flags so logging is initialized before any command
// runs. Commander mutates the program when dispatching to a subcommand, so
// we parse a sentinel program with the same global options first; the
// residual positional `args` give us the subcommand name without a manual
// argv walk. `helpOption(false)` lets `--help` and `--version` fall through
// to the real program; `exitOverride()` keeps the probe from exiting the
// process on parse errors before we reach the main dispatch.
const globalProbe = new Command()
  .option("-v, --verbose")
  .option("--json")
  .option("--no-color")
  .option("-p, --project <path>")
  .helpOption(false)
  .allowExcessArguments(true)
  .allowUnknownOption(true)
  .exitOverride();
try {
  globalProbe.parse(process.argv, { from: "node" });
} catch {
  // Probe is best-effort. If it can't parse, the main program will surface
  // the real error in its own handler.
}
const probed = globalProbe.opts();

initLogging({
  verbose: probed.verbose === true,
  noColor: probed.color === false,
  json: probed.json === true,
});

const wantsJson = probed.json === true;
const isUpgradeRun = globalProbe.args[0] === "upgrade";

// `exitOverride` and `configureOutput` are per-command and not inherited
// through `addCommand`, so without this walk a subcommand's parse error
// prints commander's plain text and exits 1, bypassing the JSON envelope
// and the exit-2 usage convention enforced by the handler below. In --json
// mode commander's own error printing is silenced so the envelope is the
// only output.
// `writeErr` is silenced too: commander renders the help body for a missing
// subcommand through it rather than through `outputError`, which would print a
// screen of human text ahead of the envelope.
function overrideExit(cmd: Command): void {
  cmd.exitOverride();
  if (wantsJson) cmd.configureOutput({ outputError: () => {}, writeErr: () => {} });
  for (const sub of cmd.commands) overrideExit(sub);
}
overrideExit(program);

// Kick off the cached-state read and (optionally) a background fetch
// before parsing so the banner is ready by the time the command exits.
// The upgrade command does its own version handling, so skip it there.
const updateCheck = isUpgradeRun
  ? { printBannerIfOutdated: () => {}, dispose: () => {} }
  : await startUpdateCheck({
      repository: REPOSITORY,
      currentVersion: CLI_VERSION,
      json: wantsJson,
    });

// Commander error codes that mean the invocation itself was wrong. They exit
// 2 (CLI-usage convention), matching the treatment of UserError, and take
// precedence over commander's hardcoded `exitCode = 1`.
const USAGE_ERROR_CODES = new Set([
  "commander.unknownOption",
  "commander.missingArgument",
  "commander.optionMissingArgument",
  "commander.missingMandatoryOptionValue",
  "commander.invalidArgument",
  "commander.unknownCommand",
  "commander.excessArguments",
  "commander.conflictingOption",
]);

try {
  await program.parseAsync(process.argv);
  updateCheck.printBannerIfOutdated();
  updateCheck.dispose();
} catch (err) {
  updateCheck.dispose();
  const error = err as Error & { code?: string; exitCode?: number };

  if (error.code === "commander.version" || error.code === "commander.helpDisplayed") {
    process.exit(0);
  }

  // Commander renders help for two very different situations and tells them
  // apart only by exit code: an explicit `--help` (0) and "you named a command
  // group but no subcommand" (1). The latter is a usage error — exiting 0 with
  // an empty stdout made `pluggy workspace > out && parse out` silently pass.
  if (error.code === "commander.help") {
    if (error.exitCode === 0) process.exit(0);
    const group = globalProbe.args[0];
    const hint =
      group === undefined ? "Run `pluggy --help`." : `Run \`pluggy ${group} --help\` to see them.`;
    if (wantsJson) emitError("missing subcommand", 2, { hint });
    process.exit(2);
  }

  // @inquirer/prompts throws ExitPromptError on Ctrl+C: a deliberate abort,
  // not a failure. Detected by name so inquirer stays out of this module.
  // 130 = 128 + SIGINT, the conventional interrupted-by-user exit code.
  if (error.name === "ExitPromptError") {
    if (wantsJson) emitError("aborted", 130);
    else console.error(dim("Aborted."));
    process.exit(130);
  }

  const exitCode =
    error instanceof UserError || USAGE_ERROR_CODES.has(error.code ?? "")
      ? 2
      : (error.exitCode ?? 1);

  // Commander prints its own parse-time errors before throwing and rewraps
  // them as plain CommanderError instances; exit without emitError to avoid
  // double-printing in human mode. In --json mode commander's print was
  // silenced by `overrideExit`, so emit the envelope here (commander folds
  // the "(Did you mean …)" suggestion into the message as a second line;
  // surface it as the hint). Action-thrown InvalidArgumentError is *not*
  // printed by commander, so let those fall through to emitError below.
  if (error.code?.startsWith("commander.") && !(error instanceof InvalidArgumentError)) {
    if (wantsJson) {
      const lines = error.message.replace(/^error: /, "").split("\n");
      const hint = lines.slice(1).join(" ").trim();
      emitError(lines[0] ?? error.message, exitCode, hint.length > 0 ? { hint } : {});
    }
    process.exit(exitCode);
  }

  const details = isTypedError(error)
    ? {
        code: error.code,
        hint: error.hint,
        source: formatSource(error.source),
        context: error.context,
        causes: causeMessages(error),
      }
    : {};
  emitError(error.message, exitCode, details);
  process.exit(exitCode);
}
