import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

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

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith(".ts") && !path.endsWith(".test.ts") ? [path] : [];
  });
}

// `src/errors.ts` calls `code` a "stable identifier for scripting" — a
// contract. Sixty of the seventy-odd codes appeared nowhere in the docs, so
// there was no way for a script author to discover what they could branch on.
// This keeps the reference honest without anyone having to remember.
test("every error code is documented in docs/error-codes.md", () => {
  const reference = readFileSync("docs/error-codes.md", "utf8");
  const declared = new Set<string>();
  for (const file of sourceFiles("src")) {
    for (const match of readFileSync(file, "utf8").matchAll(/code:\s*["'`](E_[A-Z0-9_]+)["'`]/g)) {
      declared.add(match[1]);
    }
  }

  expect(declared.size).toBeGreaterThan(50);
  const undocumented = [...declared].filter((code) => !reference.includes(code)).sort();
  expect(undocumented).toEqual([]);
});

test("docs/error-codes.md lists no codes that no longer exist", () => {
  const reference = readFileSync("docs/error-codes.md", "utf8");
  const declared = new Set<string>();
  for (const file of sourceFiles("src")) {
    for (const match of readFileSync(file, "utf8").matchAll(/code:\s*["'`](E_[A-Z0-9_]+)["'`]/g)) {
      declared.add(match[1]);
    }
  }

  // Trailing `_` excludes the `E_IDENTIFIER_*` style wildcards used in prose.
  const documented = [
    ...new Set([...reference.matchAll(/\bE_[A-Z0-9_]*[A-Z0-9]\b/g)].map((m) => m[0])),
  ];
  // `E_<COMMAND>_NO_PROJECT` is assembled at runtime by `resolveScope`, so the
  // page lists variants that never appear as a literal in the source.
  const stale = documented
    .filter((code) => !declared.has(code) && !code.endsWith("_NO_PROJECT"))
    .sort();
  expect(stale).toEqual([]);
});
