/**
 * `pluggy workspaces`: list the workspaces declared in this project with
 * their role, platforms, dep graph position, and built-jar output path.
 *
 * Role is derived: a workspace with `main` is `shipping` (gets loaded by a
 * platform); the rest are `internal` (typically shaded into a sibling or
 * consumed via `workspace:` deps).
 *
 * JSON output ships with `schemaVersion: 1` from day one — CI scripts will
 * read this, and an envelope makes future shape changes additive.
 */

import process from "node:process";

import { Command } from "commander";

import { bold, dim, emit, log } from "../logging.ts";
import { toPosixPath } from "../portable.ts";
import {
  resolveWorkspaceContext,
  topologicalOrder,
  workspaceDependencyNames,
} from "../workspace.ts";

export interface WorkspacesCommandOptions {
  cwd?: string;
}

export interface WorkspaceListing {
  name: string;
  rootDir: string;
  role: "shipping" | "internal";
  main: string | null;
  platforms: string[];
  dependsOn: string[];
  outputPath: string;
}

export interface WorkspacesCommandResult {
  schemaVersion: 1;
  workspaces: WorkspaceListing[];
}

export async function runWorkspacesCommand(
  opts: WorkspacesCommandOptions = {},
): Promise<WorkspacesCommandResult> {
  const cwd = opts.cwd ?? process.cwd();
  const context = resolveWorkspaceContext(cwd);
  if (context === undefined) {
    throw new Error("No pluggy project found. Run this from inside a project directory.");
  }

  const ordered = topologicalOrder(context.workspaces);
  const knownNames = new Set(ordered.map((n) => n.name));

  const listings: WorkspaceListing[] = ordered.map((node) => {
    const project = node.project;
    const role: "shipping" | "internal" =
      typeof project.main === "string" && project.main.length > 0 ? "shipping" : "internal";
    const dependsOn = workspaceDependencyNames(node).filter((n) => knownNames.has(n));
    const platforms = project.compatibility?.platforms ?? [];
    const jarName = `${project.name}-${project.version}.jar`;
    const outputPath = toPosixPath(`${node.root}/bin/${jarName}`);
    return {
      name: project.name,
      rootDir: node.root,
      role,
      main: typeof project.main === "string" && project.main.length > 0 ? project.main : null,
      platforms,
      dependsOn,
      outputPath,
    };
  });

  const result: WorkspacesCommandResult = {
    schemaVersion: 1,
    workspaces: listings,
  };

  emit(result as unknown as Record<string, unknown>, () => renderHuman(listings));

  return result;
}

function renderHuman(listings: WorkspaceListing[]): void {
  if (listings.length === 0) {
    log.info(dim("No workspaces declared. (Add a `workspaces` array to project.json.)"));
    return;
  }

  const headers: [string, string, string, string, string] = [
    "NAME",
    "ROLE",
    "PLATFORMS",
    "DEPENDS-ON",
    "OUTPUT",
  ];
  const rows: Array<[string, string, string, string, string]> = listings.map((w) => [
    w.name,
    w.role,
    w.platforms.length > 0 ? w.platforms.join(",") : dim("-"),
    w.dependsOn.length > 0 ? w.dependsOn.join(", ") : dim("-"),
    w.outputPath,
  ]);

  const widths = headers.map((h, i) => {
    let w = visualLength(h);
    for (const row of rows) w = Math.max(w, visualLength(row[i]));
    return w;
  });

  const renderRow = (row: [string, string, string, string, string], bolded: boolean): void => {
    const padded = row.map((cell, i) => padEnd(cell, widths[i]));
    log.info(bolded ? bold(padded.join("  ")) : padded.join("  "));
  };

  renderRow(headers, true);
  for (const row of rows) renderRow(row, false);
}

/** Length ignoring ANSI escape sequences so padding lines up under color. */
function visualLength(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1B\[[0-9;]*m/g, "").length;
}

function padEnd(s: string, n: number): string {
  const pad = n - visualLength(s);
  return pad > 0 ? s + " ".repeat(pad) : s;
}

/** Factory for the `pluggy workspaces` commander command. */
export function workspacesCommand(): Command {
  return new Command("workspaces")
    .description("List the workspaces declared in this project.")
    .action(async function action(this: Command) {
      await runWorkspacesCommand({});
    });
}
