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
import { emitError, initLogging } from "./logging.ts";
import { startUpdateCheck } from "./update-check.ts";

// Side-effect import: platform providers self-register via createPlatform.
import "./platform/index.ts";

const CLI_VERSION = "0.0.0";
const REPOSITORY = "pluggy-sh/pluggy";

const program = new Command()
  .name("pluggy")
  .description("A CLI for developing Minecraft plugins.")
  .version(CLI_VERSION, "-V, --version", "Print pluggy's version and exit.")
  .option("-v, --verbose", "Enable verbose output.")
  .option("-p, --project <path>", "Path to a custom project file.")
  .option("--json", "Output results as JSON.")
  .option("--no-color", "Disable colored output.")
  .addHelpText("after", `\nExamples:\n  $ pluggy init --help     Get help for a command`);

program.addCommand(initCommand());
program.addCommand(installCommand());
program.addCommand(removeCommand());
program.addCommand(infoCommand());
program.addCommand(searchCommand());
program.addCommand(listCommand());
program.addCommand(whyCommand());
program.addCommand(outdatedCommand());
program.addCommand(auditCommand());
program.addCommand(runCommand());
program.addCommand(buildCommand());
program.addCommand(testCommand());
program.addCommand(docsCommand());
program.addCommand(doctorCommand({ pluggyVersion: CLI_VERSION, repository: REPOSITORY }));
program.addCommand(devCommand());
program.addCommand(sdkCommand());
program.addCommand(cacheCommand());
program.addCommand(cleanCommand());
program.addCommand(upgradeCommand({ repository: REPOSITORY }));
program.addCommand(workspaceCommand());
program.addCommand(workspacesCommand());
program.addCommand(explainCommand());
program.addCommand(graphCommand());
program.addCommand(completionsCommand(program));
// Hidden helper used by shell completion scripts. Lives at the top level so
// it's invokable as `pluggy __complete-workspaces`; not surfaced in --help.
program.addCommand(completeWorkspacesCommand(), { hidden: true });

program.exitOverride();

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

  const exitCode =
    error.exitCode ?? (error instanceof UserError || error instanceof InvalidArgumentError ? 2 : 1);

  if (error.code?.startsWith("commander.") && !wantsJson) {
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
