#!/usr/bin/env bun
import process from "node:process";

import { Command, InvalidArgumentError } from "commander";

import { buildCommand } from "./commands/build.ts";
import { completionsCommand } from "./commands/completions.ts";
import { devCommand } from "./commands/dev.ts";
import { doctorCommand } from "./commands/doctor.ts";
import { infoCommand } from "./commands/info.ts";
import { initCommand } from "./commands/init.ts";
import { installCommand } from "./commands/install.ts";
import { listCommand } from "./commands/list.ts";
import { removeCommand } from "./commands/remove.ts";
import { searchCommand } from "./commands/search.ts";
import { testCommand } from "./commands/test.ts";
import { upgradeCommand } from "./commands/upgrade.ts";
import { bold, red } from "./logging.ts";

// Side-effect import: platform providers self-register via createPlatform.
import "./platform/index.ts";

const CLI_VERSION = "0.0.0";

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
program.addCommand(buildCommand());
program.addCommand(testCommand());
program.addCommand(doctorCommand());
program.addCommand(devCommand());
program.addCommand(upgradeCommand({ repository: "ch99q/pluggy" }));
program.addCommand(completionsCommand(program));

program.exitOverride();

try {
  await program.parseAsync(process.argv);
} catch (err) {
  const error = err as Error & { code?: string; exitCode?: number };

  if (
    error.code === "commander.help" ||
    error.code === "commander.helpDisplayed" ||
    error.code === "commander.version"
  ) {
    process.exit(0);
  }

  const globalOpts = program.opts();
  const exitCode = error.exitCode ?? (error instanceof InvalidArgumentError ? 2 : 1);

  if (globalOpts.json) {
    console.error(JSON.stringify({ status: "error", message: error.message, exitCode }, null, 2));
    process.exit(exitCode);
  }

  if (error.code?.startsWith("commander.")) {
    process.exit(exitCode);
  }

  console.error(red(`  ${bold("error")}: ${error.message}\n`));
  process.exit(exitCode);
}
