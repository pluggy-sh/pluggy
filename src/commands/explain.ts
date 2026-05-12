/**
 * `pluggy explain [name]`: print the post-inheritance view of a workspace
 * (or the current project) so users can see what fields came from where.
 *
 * After Track 1's inheritance extension, "wait, where's this dep coming
 * from?" is a real failure mode. This command surfaces it by tagging each
 * top-level field as `declared` (in the workspace's own `project.json`),
 * `inherited` (came from the root via `mergeInheritance`), or `merged`
 * (registries / dependencies / scripts that combined both sides).
 */

import { readFileSync } from "node:fs";
import process from "node:process";

import { Command, InvalidArgumentError } from "commander";

import { bold, dim, emit, log } from "../logging.ts";
import type { Project, ResolvedProject } from "../project.ts";
import { findWorkspace, resolveWorkspaceContext, type WorkspaceContext } from "../workspace.ts";

export interface ExplainCommandOptions {
  name?: string;
  cwd?: string;
}

export type FieldOrigin = "declared" | "inherited" | "merged" | "absent";

export interface ExplainCommandResult {
  status: "success";
  exitCode: 0;
  name: string;
  rootDir: string;
  /** The merged project view as it appears to the rest of the codebase. */
  project: Project;
  /** Per-top-level-field origin. `merged` means both sides contributed. */
  origins: Record<string, FieldOrigin>;
}

const FIELDS = [
  "name",
  "version",
  "description",
  "authors",
  "main",
  "compatibility",
  "dependencies",
  "testDependencies",
  "registries",
  "shading",
  "resources",
  "workspaces",
  "dev",
  "docs",
  "test",
  "jdk",
  "scripts",
] as const;

const MERGED_FIELDS = new Set(["registries", "dependencies", "scripts"]);

export async function runExplainCommand(
  opts: ExplainCommandOptions = {},
): Promise<ExplainCommandResult> {
  const cwd = opts.cwd ?? process.cwd();
  const context = resolveWorkspaceContext(cwd);
  if (context === undefined) {
    throw new Error("No pluggy project found. Run this from inside a project directory.");
  }

  const { merged, raw, rootDir, name } = pickTarget(context, opts.name);
  const origins = computeOrigins(merged, raw, context.root);

  const result: ExplainCommandResult = {
    status: "success",
    exitCode: 0,
    name,
    rootDir,
    project: stripResolved(merged),
    origins,
  };

  emit(result as unknown as Record<string, unknown>, () => renderHuman(result, raw));

  return result;
}

function pickTarget(
  context: WorkspaceContext,
  requested: string | undefined,
): { merged: ResolvedProject; raw: Project; rootDir: string; name: string } {
  if (requested !== undefined) {
    const node = findWorkspace(context, requested);
    const raw = readRaw(node.project.projectFile);
    return { merged: node.project, raw, rootDir: node.root, name: node.name };
  }
  if (context.current !== undefined) {
    const raw = readRaw(context.current.project.projectFile);
    return {
      merged: context.current.project,
      raw,
      rootDir: context.current.root,
      name: context.current.name,
    };
  }
  if (context.atRoot && context.workspaces.length > 0) {
    throw new InvalidArgumentError(
      `pass a workspace name: ${context.workspaces.map((w) => w.name).join(", ")}.`,
    );
  }
  const raw = readRaw(context.root.projectFile);
  return {
    merged: context.root,
    raw,
    rootDir: context.root.rootDir,
    name: context.root.name,
  };
}

function readRaw(path: string): Project {
  const text = readFileSync(path, "utf8");
  return JSON.parse(text) as Project;
}

function stripResolved(project: ResolvedProject): Project {
  const { rootDir: _r, projectFile: _p, ...rest } = project;
  return rest;
}

function computeOrigins(
  merged: ResolvedProject,
  raw: Project,
  root: ResolvedProject,
): Record<string, FieldOrigin> {
  const out: Record<string, FieldOrigin> = {};
  const isRoot = merged.projectFile === root.projectFile;
  for (const field of FIELDS) {
    const mergedHas = (merged as unknown as Record<string, unknown>)[field] !== undefined;
    const rawHas = (raw as unknown as Record<string, unknown>)[field] !== undefined;
    const rootHas = (root as unknown as Record<string, unknown>)[field] !== undefined;
    if (!mergedHas) {
      out[field] = "absent";
      continue;
    }
    if (isRoot) {
      // The root project doesn't inherit from anywhere; everything mergedHas
      // is declared.
      out[field] = "declared";
      continue;
    }
    if (MERGED_FIELDS.has(field) && rawHas && rootHas) {
      out[field] = "merged";
      continue;
    }
    out[field] = rawHas ? "declared" : "inherited";
  }
  return out;
}

function renderHuman(result: ExplainCommandResult, raw: Project): void {
  log.heading(`${bold(result.name)} ${dim(result.rootDir)}`);
  log.info("");

  const order: Array<(typeof FIELDS)[number]> = FIELDS.filter(
    (f) => result.origins[f] !== "absent",
  ) as Array<(typeof FIELDS)[number]>;

  const labelWidth = Math.max(...order.map((f) => f.length));
  for (const field of order) {
    const origin = result.origins[field];
    const tag = formatOriginTag(origin);
    const value = formatValue(
      field,
      (result.project as unknown as Record<string, unknown>)[field],
      raw,
    );
    log.info(`  ${field.padEnd(labelWidth)}  ${tag}  ${value}`);
  }
}

function formatOriginTag(origin: FieldOrigin): string {
  switch (origin) {
    case "declared":
      return dim("declared ");
    case "inherited":
      return dim("inherited");
    case "merged":
      return dim("merged   ");
    case "absent":
      return dim("absent   ");
  }
}

function formatValue(field: string, value: unknown, raw: Project): string {
  if (value === undefined || value === null) return dim("(none)");
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return dim("[]");
    return JSON.stringify(value);
  }
  if (typeof value === "object") {
    if (field === "dependencies" || field === "scripts") {
      return formatMergedMap(
        value as Record<string, unknown>,
        (raw as unknown as Record<string, unknown>)[field] as Record<string, unknown> | undefined,
      );
    }
    return JSON.stringify(value);
  }
  return JSON.stringify(value);
}

function formatMergedMap(
  merged: Record<string, unknown>,
  rawSide: Record<string, unknown> | undefined,
): string {
  const keys = Object.keys(merged).sort();
  if (keys.length === 0) return dim("{}");
  const parts: string[] = [];
  for (const key of keys) {
    const owned = rawSide !== undefined && key in rawSide;
    const value = merged[key];
    const v =
      typeof value === "string"
        ? value
        : ((value as { source?: string }).source ?? JSON.stringify(value));
    parts.push(`${key}=${v}${owned ? "" : dim(" (inherited)")}`);
  }
  return parts.join(", ");
}

/** Factory for the `pluggy explain` commander command. */
export function explainCommand(): Command {
  return new Command("explain")
    .description("Show a workspace's post-inheritance project view (declared vs inherited fields).")
    .argument(
      "[name]",
      "Workspace to inspect. Defaults to the current workspace (or the root standalone project).",
    )
    .action(async function action(this: Command, name: string | undefined) {
      await runExplainCommand({ name });
    });
}
