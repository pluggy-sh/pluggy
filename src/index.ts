#!/usr/bin/env bun
import process from "node:process";

import { Command, InvalidArgumentError } from "commander";

import { buildCommand } from "./commands/build.ts";
import { cacheCommand } from "./commands/cache.ts";
import { completionsCommand } from "./commands/completions.ts";
import { devCommand } from "./commands/dev.ts";
import { docsCommand } from "./commands/docs.ts";
import { doctorCommand } from "./commands/doctor.ts";
import { infoCommand } from "./commands/info.ts";
import { initCommand } from "./commands/init.ts";
import { installCommand } from "./commands/install.ts";
import { listCommand } from "./commands/list.ts";
import { removeCommand } from "./commands/remove.ts";
import { searchCommand } from "./commands/search.ts";
import { sdkCommand } from "./commands/sdk.ts";
import { testCommand } from "./commands/test.ts";
import { upgradeCommand } from "./commands/upgrade.ts";
import { bold, red } from "./logging.ts";
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
program.addCommand(buildCommand());
program.addCommand(testCommand());
program.addCommand(docsCommand());
program.addCommand(doctorCommand({ pluggyVersion: CLI_VERSION, repository: REPOSITORY }));
program.addCommand(devCommand());
program.addCommand(sdkCommand());
program.addCommand(cacheCommand());
program.addCommand(upgradeCommand({ repository: REPOSITORY }));
program.addCommand(completionsCommand(program));

program.exitOverride();

const wantsJson = process.argv.includes("--json");
const isUpgradeRun = detectSubcommand(process.argv) === "upgrade";

/**
 * Find the first positional argument in argv after the executable and
 * script paths. Skips global flags and consumes the value of flags that
 * take one (`-p` / `--project`) so we don't mistake the value for a
 * subcommand. Returns `undefined` if no subcommand is present.
 */
function detectSubcommand(argv: string[]): string | undefined {
  const valueFlags = new Set(["-p", "--project"]);
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") return argv[i + 1];
    if (valueFlags.has(a)) {
      i++;
      continue;
    }
    if (a.startsWith("-")) continue;
    return a;
  }
  return undefined;
}

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
