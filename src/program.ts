/**
 * Builds the command tree. Kept separate from `index.ts` so the tree can be
 * constructed without running the CLI, which is what the invariant tests in
 * `program.test.ts` need.
 */
import { Command } from "commander";

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
import { platformsCommand } from "./commands/platforms.ts";
import { removeCommand } from "./commands/remove.ts";
import { runCommand } from "./commands/run.ts";
import { searchCommand } from "./commands/search.ts";
import { sdkCommand } from "./commands/sdk.ts";
import { templatesCommand } from "./commands/templates.ts";
import { testCommand } from "./commands/test.ts";
import { updateCommand } from "./commands/update.ts";
import { upgradeCommand } from "./commands/upgrade.ts";
import { whyCommand } from "./commands/why.ts";
import { workspaceCommand } from "./commands/workspace.ts";
import { workspacesCommand } from "./commands/workspaces.ts";
import { CLI_VERSION } from "./version.ts";

export const REPOSITORY = "pluggy-sh/pluggy";

export function createProgram(): Command {
  const program = new Command()
    .name("pluggy")
    .description("A CLI for developing Minecraft plugins.")
    .version(CLI_VERSION, "-V, --version", "Print pluggy's version and exit.")
    .option("-v, --verbose", "Enable verbose output.")
    .option("-p, --project <path>", "Path to a custom project file.")
    .option("--json", "Output results as JSON.")
    .option("--no-color", "Disable colored output.")
    // Commander's built-in reads "display help for command" — lowercase and
    // period-less, which clashes with every other description in the CLI and
    // renders on every command. Overriding here fixes all of them at once.
    .helpOption("-h, --help", "Show help for a command.")
    .addHelpText(
      "after",
      `\nExamples:\n  $ pluggy init            Create a new plugin project\n  $ pluggy init --help     Get help for a command\n\nDocs: https://github.com/${REPOSITORY}/tree/main/docs`,
    );

  program.commandsGroup("Start:");
  program.addCommand(initCommand());
  program.addCommand(platformsCommand());
  program.addCommand(templatesCommand());

  program.commandsGroup("Dependencies:");
  program.addCommand(installCommand());
  program.addCommand(updateCommand());
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

  program.commandsGroup("Workspaces:");
  program.addCommand(workspaceCommand());

  program.commandsGroup("Toolchain:");
  program.addCommand(sdkCommand());
  program.addCommand(cacheCommand());
  program.addCommand(cleanCommand());

  // `Maintain:` mixed toolchain management with commands about the CLI itself;
  // the old grouping comment already called these "the other meta commands".
  program.commandsGroup("Meta:");
  program.addCommand(doctorCommand({ pluggyVersion: CLI_VERSION, repository: REPOSITORY }));
  program.addCommand(upgradeCommand({ repository: REPOSITORY }));
  program.addCommand(completionsCommand(program));

  // Commander's implicit `help` command skips group assignment when created
  // lazily and would render under a stray "Commands:" heading; declaring it
  // explicitly files it under Meta with the other CLI-about-itself commands.
  program.commandsGroup("Meta:");
  program.helpCommand("help [command]", "Show help for a command.");

  // `workspaces` and `graph` moved under the `workspace` namespace. Kept
  // reachable but hidden so existing scripts and muscle memory keep working
  // through the next minor.
  program.addCommand(explainCommand(), { hidden: true });
  program.addCommand(workspacesCommand(), { hidden: true });
  program.addCommand(graphCommand(), { hidden: true });
  // Hidden helper used by shell completion scripts. Lives at the top level so
  // it's invokable as `pluggy __complete-workspaces`; not surfaced in --help.
  program.addCommand(completeWorkspacesCommand(), { hidden: true });

  applyHelpOption(program);
  return program;
}

/**
 * `helpOption` is per-command and not inherited through `addCommand`, so
 * without this walk commander's lowercase, period-less "display help for
 * command" renders on every subcommand — the most-repeated string in the CLI
 * and the only one matching no other description's style.
 */
function applyHelpOption(command: Command): void {
  command.helpOption("-h, --help", "Show help for a command.");
  for (const sub of command.commands) applyHelpOption(sub);
}
