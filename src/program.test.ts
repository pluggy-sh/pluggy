import type { Command } from "commander";
import { expect, test } from "vite-plus/test";

import { createProgram } from "./program.ts";

function walk(command: Command, path: string[] = []): Array<{ path: string; command: Command }> {
  const here = [...path, command.name()];
  const self = path.length === 0 ? [] : [{ path: here.join(" "), command }];
  return [...self, ...command.commands.flatMap((sub) => walk(sub, here))];
}

const program = createProgram();
const subcommands = walk(program);
const globalLongs = new Set(program.options.map((o) => o.long).filter((l): l is string => !!l));

// `pluggy init --version 2.0.0` printed the CLI's own version, created nothing,
// and exited 0 — a documented flag that silently no-opped. The same bug had
// already shipped once on `dev`/`search` and was fixed there by renaming to
// `--mc-version`; `init` and `workspace add` were missed. This is the guard.
test("no subcommand declares an option that a global flag shadows", () => {
  const collisions = subcommands.flatMap(({ path, command }) =>
    command.options
      .map((o) => o.long)
      .filter((long): long is string => long != null && globalLongs.has(long))
      .map((long) => `${path} ${long}`),
  );
  expect(collisions).toEqual([]);
});

test("every command declares a description", () => {
  const missing = subcommands.filter(({ command }) => command.description().trim() === "");
  expect(missing.map((m) => m.path)).toEqual([]);
});

// A namespace with no action handler falls through to commander's help, which
// used to exit 0 with empty stdout. Those that cannot act must at least be
// reachable; those that can should default to their read action.
test("command groups either act or delegate to subcommands", () => {
  for (const { path, command } of subcommands) {
    const actionable =
      command.commands.length > 0 ||
      (command as Command & { _actionHandler?: unknown })._actionHandler !== undefined;
    expect(actionable, `${path} has neither an action nor subcommands`).toBe(true);
  }
});
