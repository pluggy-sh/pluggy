#!/usr/bin/env bun
import process from "node:process";

import { Command, InvalidArgumentError } from "commander";

import { auditCommand } from "./commands/audit.ts";
import { buildCommand } from "./commands/build.ts";
import { cacheCommand } from "./commands/cache.ts";
import { cleanCommand } from "./commands/clean.ts";
import { completeWorkspacesCommand, completionsCommand } from "./commands/completions.ts";
import { devCommand } from "./commands/dev.ts";
import { docsCommand } from "./commands/docs.ts";
import { doctorCommand } from "./commands/doctor.ts";
import { explainCommand } from "./commands/explain.ts";
import { graphCommand } from "./commands/graph.ts";
import { infoCommand } from "./commands/info.ts";
import { initCommand } from "./commands/init.ts";
import { installCommand } from "./commands/install.ts";
import { listCommand } from "./commands/list.ts";
import { outdatedCommand } from "./commands/outdated.ts";
import { removeCommand } from "./commands/remove.ts";
import { runCommand } from "./commands/run.ts";
import { searchCommand } from "./commands/search.ts";
import { sdkCommand } from "./commands/sdk.ts";
import { testCommand } from "./commands/test.ts";
import { upgradeCommand } from "./commands/upgrade.ts";
import { whyCommand } from "./commands/why.ts";
import { workspaceCommand } from "./commands/workspace.ts";
import { workspacesCommand } from "./commands/workspaces.ts";
import { causeMessages, formatSource, isTypedError, UserError } from "./errors.ts";
import { dim, emitError, initLogging } from "./logging.ts";
import { startUpdateCheck } from "./update-check.ts";
import { CLI_VERSION } from "./version.ts";

// Side-effect import: platform providers self-register via createPlatform.
import "./platform/index.ts";

const REPOSITORY = "pluggy-sh/pluggy";

const program = new Command()
  .name("pluggy")
  .description("A CLI for developing Minecraft plugins.")
  .version(CLI_VERSION, "-V, --version", "Print pluggy's version and exit.")
  .option("-v, --verbose", "Enable verbose output.")
  .option("-p, --project <path>", "Path to a custom project file.")
  .option("--json", "Output results as JSON.")
  .option("--no-color", "Disable colored output.")
  .addHelpText(
    "after",
    `\nExamples:\n  $ pluggy init            Create a new plugin project\n  $ pluggy init --help     Get help for a command\n\nDocs: https://github.com/${REPOSITORY}/tree/main/docs`,
  );

program.commandsGroup("Start:");
program.addCommand(initCommand());

program.commandsGroup("Dependencies:");
program.addCommand(installCommand());
program.addCommand(removeCommand());
program.addCommand(infoCommand());
program.addCommand(searchCommand());
program.addCommand(listCommand());
program.addCommand(whyCommand());
program.addCommand(outdatedCommand());
program.addCommand(auditCommand());

program.commandsGroup("Develop:");
program.addCommand(runCommand());
program.addCommand(buildCommand());
program.addCommand(testCommand());
program.addCommand(docsCommand());
program.addCommand(devCommand());

program.commandsGroup("Maintain:");
program.addCommand(doctorCommand({ pluggyVersion: CLI_VERSION, repository: REPOSITORY }));
program.addCommand(sdkCommand());
program.addCommand(cacheCommand());
program.addCommand(cleanCommand());
program.addCommand(upgradeCommand({ repository: REPOSITORY }));
program.addCommand(completionsCommand(program));

program.commandsGroup("Workspaces:");
program.addCommand(workspaceCommand());
program.addCommand(workspacesCommand());
program.addCommand(explainCommand());
program.addCommand(graphCommand());

// Commander's implicit `help` command skips group assignment when created
// lazily and would render under a stray "Commands:" heading; declaring it
// explicitly files it under Maintain with the other meta commands.
program.commandsGroup("Maintain:");
program.helpCommand("help [command]", "Display help for a command.");
// Hidden helper used by shell completion scripts. Lives at the top level so
// it's invokable as `pluggy __complete-workspaces`; not surfaced in --help.
program.addCommand(completeWorkspacesCommand(), { hidden: true });

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
function overrideExit(cmd: Command): void {
  cmd.exitOverride();
  if (wantsJson) cmd.configureOutput({ outputError: () => {} });
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

  if (
    error.code === "commander.help" ||
    error.code === "commander.helpDisplayed" ||
    error.code === "commander.version"
  ) {
    process.exit(0);
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
