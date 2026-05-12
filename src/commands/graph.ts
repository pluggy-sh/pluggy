/**
 * `pluggy graph`: render the workspace dependency graph. Two modes:
 *   • default: a tidy text listing in topological order, with each
 *     workspace's `workspace:` deps inlined after an arrow.
 *   • `--mermaid`: emit a Mermaid `graph TD` definition that pastes into
 *     GitHub markdown / Notion / wikis without further fuss.
 *
 * Output is intentionally derived purely from the workspace context — no
 * lockfile reads, no network — so it stays fast and trustworthy even when
 * the project is in a half-broken state.
 */

import process from "node:process";

import { Command } from "commander";

import { bold, dim, emit, log } from "../logging.ts";
import {
  resolveWorkspaceContext,
  topologicalOrder,
  workspaceDependencyNames,
} from "../workspace.ts";

export interface GraphCommandOptions {
  mermaid?: boolean;
  cwd?: string;
}

export interface GraphEdge {
  from: string;
  to: string;
}

export interface GraphCommandResult {
  status: "success";
  exitCode: 0;
  nodes: string[];
  edges: GraphEdge[];
  /** Mermaid `graph TD` text, populated when `--mermaid` was passed. */
  mermaid?: string;
}

export async function runGraphCommand(opts: GraphCommandOptions = {}): Promise<GraphCommandResult> {
  const cwd = opts.cwd ?? process.cwd();
  const context = resolveWorkspaceContext(cwd);
  if (context === undefined) {
    throw new Error("No pluggy project found. Run this from inside a project directory.");
  }

  const ordered = topologicalOrder(context.workspaces);
  const known = new Set(ordered.map((n) => n.name));
  const nodes = ordered.map((n) => n.name);
  const edges: GraphEdge[] = [];
  for (const node of ordered) {
    for (const depName of workspaceDependencyNames(node)) {
      if (!known.has(depName)) continue;
      edges.push({ from: node.name, to: depName });
    }
  }

  const result: GraphCommandResult = {
    status: "success",
    exitCode: 0,
    nodes,
    edges,
  };
  if (opts.mermaid === true) result.mermaid = renderMermaid(nodes, edges);

  emit(result as unknown as Record<string, unknown>, () => {
    if (nodes.length === 0) {
      log.info(dim("No workspaces declared."));
      return;
    }
    if (opts.mermaid === true) {
      // Print the mermaid text raw so the user can pipe it / copy it.
      console.log(result.mermaid);
      return;
    }
    renderTree(nodes, edges);
  });

  return result;
}

function renderTree(nodes: string[], edges: GraphEdge[]): void {
  const depsByNode = new Map<string, string[]>();
  for (const name of nodes) depsByNode.set(name, []);
  for (const edge of edges) {
    depsByNode.get(edge.from)?.push(edge.to);
  }

  log.heading("Workspace graph");
  for (const name of nodes) {
    const deps = depsByNode.get(name) ?? [];
    if (deps.length === 0) {
      log.info(`  ${bold(name)}`);
    } else {
      log.info(`  ${bold(name)} ${dim("←")} ${deps.join(", ")}`);
    }
  }
}

function renderMermaid(nodes: string[], edges: GraphEdge[]): string {
  const lines: string[] = ["graph TD"];
  for (const name of nodes) {
    lines.push(`  ${mermaidId(name)}["${name}"]`);
  }
  for (const edge of edges) {
    lines.push(`  ${mermaidId(edge.from)} --> ${mermaidId(edge.to)}`);
  }
  return lines.join("\n");
}

/**
 * Mermaid identifiers can't contain dots or dashes without quoting. Pluggy's
 * workspace names allow both, so we sanitise to alphanumerics + underscore.
 * The display label is preserved separately via the `["..."]` annotation.
 */
function mermaidId(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/g, "_");
}

/** Factory for the `pluggy graph` commander command. */
export function graphCommand(): Command {
  return new Command("graph")
    .description("Render the workspace dependency graph (text by default).")
    .option("--mermaid", "Emit a Mermaid `graph TD` definition instead of the text rendering.")
    .action(async function action(this: Command, options) {
      await runGraphCommand({ mermaid: options.mermaid === true });
    });
}
