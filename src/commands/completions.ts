import process from "node:process";

import type { Command, Option } from "commander";
import { Command as CommanderCommand, InvalidArgumentError } from "commander";

import { resolveWorkspaceContext } from "../workspace.ts";

type Shell = "bash" | "zsh" | "fish" | "pwsh";

interface CommandSnapshot {
  name: string;
  aliases: string[];
  description: string;
  flags: FlagSnapshot[];
}

interface FlagSnapshot {
  long?: string;
  short?: string;
  description: string;
}

interface Snapshot {
  program: string;
  globalFlags: FlagSnapshot[];
  subcommands: CommandSnapshot[];
}

const SHELLS: readonly Shell[] = ["bash", "zsh", "fish", "pwsh"] as const;

function parseShell(value: string): Shell {
  const lower = value.toLowerCase();
  if ((SHELLS as readonly string[]).includes(lower)) return lower as Shell;
  throw new InvalidArgumentError(`Unknown shell "${value}". Supported: ${SHELLS.join(", ")}.`);
}

/**
 * Factory for the `pluggy completions` commander command. Takes the program
 * by reference so the `.action` can walk the live command tree at invocation
 * time. Users see the same commands they'd see from `pluggy --help`.
 */
export function completionsCommand(program: Command): Command {
  return new CommanderCommand("completions")
    .description("Print a shell completion script for pluggy.")
    .argument("<shell>", "Target shell: bash, zsh, fish, or pwsh.", parseShell)
    .addHelpText(
      "after",
      `\nInstall the script for your shell:\n` +
        `  bash:  pluggy completions bash > /usr/local/etc/bash_completion.d/pluggy\n` +
        `  zsh:   pluggy completions zsh  > "\${fpath[1]}/_pluggy"\n` +
        `  fish:  pluggy completions fish > ~/.config/fish/completions/pluggy.fish\n` +
        `  pwsh:  pluggy completions pwsh >> $PROFILE`,
    )
    .action((shell: Shell) => {
      const snapshot = introspect(program);
      console.log(renderScript(shell, snapshot));
    });
}

/**
 * Hidden helper used by shell completion scripts to enumerate workspace
 * names in the current directory. Emits one name per line on stdout so
 * `compgen -W "$(pluggy __complete-workspaces)"` works in bash and the zsh
 * `compadd` / fish `complete` machinery can consume it too.
 *
 * Exits 0 with no output when no project is found — shell completion must
 * not crash the user's shell session.
 */
export function completeWorkspacesCommand(): Command {
  return new CommanderCommand("__complete-workspaces")
    .description("(internal) List workspace names for shell completion.")
    .helpCommand(false)
    .action(() => {
      try {
        const ctx = resolveWorkspaceContext(process.cwd());
        if (ctx === undefined) return;
        for (const node of ctx.workspaces) {
          process.stdout.write(`${node.name}\n`);
        }
      } catch {
        // Shell completion must never fail loudly. Stay silent on errors.
      }
    });
}

function introspect(program: Command): Snapshot {
  return {
    program: program.name(),
    globalFlags: program.options.map(snapshotOption),
    subcommands: program.commands
      .filter((c) => c.name() !== "completions" && c.name() !== "help")
      .map((c) => ({
        name: c.name(),
        aliases: c.aliases(),
        description: firstLine(c.description()),
        flags: c.options.map(snapshotOption),
      })),
  };
}

function snapshotOption(option: Option): FlagSnapshot {
  return {
    long: option.long ?? undefined,
    short: option.short ?? undefined,
    description: firstLine(option.description ?? ""),
  };
}

/** Shell completion formats don't tolerate multi-line descriptions. */
function firstLine(s: string): string {
  const idx = s.indexOf("\n");
  return idx === -1 ? s : s.slice(0, idx);
}

function renderScript(shell: Shell, snap: Snapshot): string {
  switch (shell) {
    case "bash":
      return renderBash(snap);
    case "zsh":
      return renderZsh(snap);
    case "fish":
      return renderFish(snap);
    case "pwsh":
      return renderPwsh(snap);
  }
}

function collectFlagTokens(flags: FlagSnapshot[]): string[] {
  const out: string[] = [];
  for (const f of flags) {
    if (f.long) out.push(f.long);
    if (f.short) out.push(f.short);
  }
  return out;
}

function renderBash(snap: Snapshot): string {
  const commandList = snap.subcommands.flatMap((c) => [c.name, ...c.aliases]).join(" ");
  const globalFlagList = collectFlagTokens(snap.globalFlags).join(" ");

  const caseArms = snap.subcommands
    .map((c) => {
      const names = [c.name, ...c.aliases].join("|");
      const flagList = collectFlagTokens(c.flags).join(" ");
      return `    ${names})\n      COMPREPLY=( $(compgen -W "${flagList} ${globalFlagList}" -- "$cur") )\n      ;;`;
    })
    .join("\n");

  return `# bash completion for ${snap.program}
_${snap.program}() {
  local cur prev words cword
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  words=("\${COMP_WORDS[@]}")
  cword=$COMP_CWORD

  local commands="${commandList}"
  local global_opts="${globalFlagList}"

  # Workspace-name completion: when the previous token is --workspace or
  # --exclude (or any of their value-receiving siblings), enumerate
  # workspaces in the local project.
  case "$prev" in
    --workspace|--exclude)
      local ws
      ws=$(${snap.program} __complete-workspaces 2>/dev/null)
      COMPREPLY=( $(compgen -W "$ws" -- "$cur") )
      return
      ;;
  esac

  if [ "$cword" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "$commands $global_opts" -- "$cur") )
    return
  fi

  case "\${words[1]}" in
${caseArms}
    *)
      COMPREPLY=( $(compgen -W "$global_opts" -- "$cur") )
      ;;
  esac
}
complete -F _${snap.program} ${snap.program}
`;
}

function renderZsh(snap: Snapshot): string {
  const commandEntries = snap.subcommands
    .map((c) => singleQuoteZsh(`${c.name}:${sanitizeZshDescription(c.description)}`))
    .map((q) => `    ${q}`)
    .join("\n");

  const caseArms = snap.subcommands
    .map((c) => {
      const names = [c.name, ...c.aliases].join("|");
      const args = c.flags
        .map((f) => {
          const spec = f.long && f.short ? `${f.short},${f.long}` : f.long || f.short || "";
          if (!spec) return "";
          return `        ${singleQuoteZsh(`${spec}[${sanitizeZshDescription(f.description)}]`)}`;
        })
        .filter((s) => s.length > 0)
        .join(" \\\n");
      return `    ${names})\n      _arguments \\\n${args}\n      ;;`;
    })
    .join("\n");

  return `#compdef ${snap.program}
# zsh completion for ${snap.program}

_${snap.program}() {
  local -a commands
  commands=(
${commandEntries}
  )

  if (( CURRENT == 2 )); then
    _describe 'pluggy commands' commands
    return
  fi

  case "$words[2]" in
${caseArms}
  esac
}

_${snap.program} "$@"
`;
}

function renderFish(snap: Snapshot): string {
  const lines: string[] = [`# fish completion for ${snap.program}`];

  for (const cmd of snap.subcommands) {
    lines.push(
      `complete -c ${snap.program} -n "__fish_use_subcommand" -a ${cmd.name} -d ${shellQuote(cmd.description)}`,
    );
    for (const alias of cmd.aliases) {
      lines.push(
        `complete -c ${snap.program} -n "__fish_use_subcommand" -a ${alias} -d ${shellQuote(`alias for ${cmd.name}`)}`,
      );
    }
    for (const flag of cmd.flags) {
      lines.push(fishFlagLine(snap.program, cmd.name, flag));
    }
  }

  for (const flag of snap.globalFlags) {
    lines.push(fishGlobalFlagLine(snap.program, flag));
  }

  return lines.join("\n") + "\n";
}

function fishFlagLine(program: string, command: string, flag: FlagSnapshot): string {
  const parts = [`complete -c ${program}`, `-n "__fish_seen_subcommand_from ${command}"`];
  if (flag.long) parts.push(`-l ${flag.long.replace(/^--/, "")}`);
  if (flag.short) parts.push(`-s ${flag.short.replace(/^-/, "")}`);
  if (flag.description) parts.push(`-d ${shellQuote(flag.description)}`);
  return parts.join(" ");
}

function fishGlobalFlagLine(program: string, flag: FlagSnapshot): string {
  const parts = [`complete -c ${program}`];
  if (flag.long) parts.push(`-l ${flag.long.replace(/^--/, "")}`);
  if (flag.short) parts.push(`-s ${flag.short.replace(/^-/, "")}`);
  if (flag.description) parts.push(`-d ${shellQuote(flag.description)}`);
  return parts.join(" ");
}

function renderPwsh(snap: Snapshot): string {
  const globals = globalFlagsPwsh(snap);
  const commandCases = snap.subcommands
    .map((c) => {
      const flagTokens = collectFlagTokens(c.flags).map((f) => `'${f}'`);
      const joined = [...flagTokens, ...(globals.length > 0 ? [globals] : [])].join(", ");
      return `        '${c.name}' { @(${joined}) | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object { [System.Management.Automation.CompletionResult]::new($_) } }`;
    })
    .join("\n");

  const commandList = snap.subcommands.map((c) => `'${c.name}'`).join(", ");

  return `# pwsh completion for ${snap.program}
Register-ArgumentCompleter -Native -CommandName ${snap.program} -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)

  $tokens = $commandAst.CommandElements | ForEach-Object { $_.ToString() }

  if ($tokens.Count -le 1) {
    @(${commandList}) | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
      [System.Management.Automation.CompletionResult]::new($_)
    }
    return
  }

  switch ($tokens[1]) {
${commandCases}
    default {
      @(${globals}) | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
        [System.Management.Automation.CompletionResult]::new($_)
      }
    }
  }
}
`;
}

function globalFlagsPwsh(snap: Snapshot): string {
  return collectFlagTokens(snap.globalFlags)
    .map((f) => `'${f}'`)
    .join(", ");
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Wrap a string as a zsh single-quoted literal. Inside single quotes
 * nothing is interpreted, including backslash escapes; embedded quotes
 * must be written as `'\''` (close, literal `'`, reopen).
 */
function singleQuoteZsh(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * `_arguments` specs use `[description]` with square brackets as the
 * delimiter, and parsers of that mini-DSL treat literal `[`, `]`, and `:`
 * specially. Collapse those to safe lookalikes so descriptions never break
 * the spec parser (the human text stays readable).
 */
function sanitizeZshDescription(s: string): string {
  return s.replace(/\[/g, "(").replace(/\]/g, ")").replace(/:/g, " -");
}
