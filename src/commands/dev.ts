import { join } from "node:path";
import process from "node:process";

import { Command, InvalidArgumentError } from "commander";

import { runDev, singleTarget, type DevTarget } from "../dev/index.ts";
import { UserError } from "../errors.ts";
import { bold, dim, emit, log } from "../logging.ts";
import { primaryPlatform, type ResolvedProject } from "../project.ts";
import {
  findWorkspace,
  projectStartDir,
  resolveWorkspaceContext,
  topologicalOrder,
  workspaceDependencyNames,
  type WorkspaceContext,
  type WorkspaceNode,
} from "../workspace.ts";

import { parseInteger, parseMcVersion, parsePlatform } from "./parsers.ts";

export interface DevCommandOptions {
  workspace?: string;
  platform?: string;
  mcVersion?: string;
  port?: number;
  memory?: string;
  clean?: boolean;
  freshWorld?: boolean;
  /** `--no-watch` → `false`; flag absence → `undefined` (treated as on). */
  watch?: boolean;
  reload?: boolean;
  /** What to do on a hotswap miss: manual (default), restart, or reload. */
  fallback?: "manual" | "reload" | "restart";
  /** `--no-hotswap` → `false`; flag absence → `undefined` (config decides). */
  hotswap?: boolean;
  /** `--debug` → true; `--debug <port>` → port number. */
  debug?: boolean | number;
  /** `--debug-suspend` → wait for a debugger before starting. */
  debugSuspend?: boolean;
  /** `--debug-expose` → bind JDWP to all interfaces (unauthenticated). */
  debugExpose?: boolean;
  offline?: boolean;
  /** Global `--project <path>` flag: resolve the project from this file instead of cwd. */
  project?: string;
  cwd?: string;
}

/**
 * Resolve the dev target, emit a startup envelope, and delegate to `runDev`.
 *
 * In `--json` mode this writes one `{status: "starting", …}` line to stdout
 * and then lets the server's stdout/stderr through unchanged (one envelope,
 * then raw output). Errors from `runDev` propagate.
 */
export async function runDevCommand(opts: DevCommandOptions): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();
  const context = resolveWorkspaceContext(projectStartDir(opts.project, cwd));
  if (context === undefined) {
    throw new UserError("No pluggy project found. Run this from inside a project directory.", {
      code: "E_DEV_NO_PROJECT",
      hint: "Run `pluggy init` to create a new project, or cd into an existing one.",
    });
  }

  const target = selectDevTarget(context, opts);
  const { server, plugins } = target;

  const platformId = opts.platform ?? server.compatibility?.platforms?.[0];
  const mcVersion = opts.mcVersion ?? server.compatibility?.versions?.[0];
  const port = opts.port ?? server.dev?.port ?? 25565;
  const devDir = join(server.rootDir, "dev");
  emit(
    {
      status: "starting",
      platform: platformId,
      version: mcVersion,
      port,
      devDir,
      plugins: plugins.map((p) => p.name),
    },
    () => {
      log.heading(`Starting dev server for ${bold(server.name)}`);
      log.step(`platform ${dim(`${platformId} ${mcVersion}`)}, port ${port}`);
      if (plugins.length > 1) {
        log.step(`plugins ${dim(plugins.map((p) => p.name).join(", "))}`);
      }
    },
  );

  await runDev(target, {
    platform: opts.platform,
    version: opts.mcVersion,
    port: opts.port,
    memory: opts.memory,
    clean: opts.clean,
    freshWorld: opts.freshWorld,
    watch: opts.watch,
    reload: opts.reload,
    fallback: opts.fallback,
    hotswap: opts.hotswap,
    debug: opts.debug,
    debugSuspend: opts.debugSuspend,
    debugExpose: opts.debugExpose,
    offline: opts.offline,
    args: server.dev?.jvmArgs,
  });
}

/**
 * Resolve what `dev` runs: one server hosting one or more plugins.
 *
 * At a root with workspaces:
 *   • `--workspace <name>` targets that one workspace.
 *   • Otherwise every workspace that declares `main` runs together on one
 *     server (a suite dev server). A single shipping workspace is auto-picked
 *     and its own dir hosts the server; two or more run at the root and must
 *     share a platform (you can't co-host paper and sponge in one JVM).
 *   • Zero shipping workspaces is an error: there's no plugin to run.
 *
 * Inside a workspace it targets that workspace; standalone projects target
 * their root. `buildOrder` always lists the target's `workspace:` dependency
 * closure so libraries build before the plugins that link them.
 */
export function selectDevTarget(
  context: WorkspaceContext,
  opts: Pick<DevCommandOptions, "workspace">,
): DevTarget {
  if (context.atRoot && context.workspaces.length > 0) {
    if (opts.workspace !== undefined) {
      return oneWorkspaceTarget(context, findWorkspace(context, opts.workspace));
    }
    const shipping = context.workspaces.filter((w) => hasMain(w.project));
    if (shipping.length === 0) {
      throw new InvalidArgumentError(
        `dev found no plugin to run: no workspace declares \`main\`.\n${workspaceTable(context.workspaces)}`,
      );
    }
    if (shipping.length === 1) {
      const chosen = shipping[0];
      log.info(
        `${dim("→")} dev: auto-selected workspace "${chosen.name}" (only shipping workspace)`,
      );
      return oneWorkspaceTarget(context, chosen);
    }
    const platformsUsed = new Set(shipping.map((w) => primaryPlatform(w.project)));
    if (platformsUsed.size > 1) {
      throw new InvalidArgumentError(
        `dev can't co-host workspaces on different platforms in one server; pass --workspace <name> to run one.\n${workspaceTable(shipping)}`,
      );
    }
    return {
      server: context.root,
      buildOrder: topologicalOrder(context.workspaces).map((w) => w.project),
      plugins: topologicalOrder(shipping).map((w) => w.project),
    };
  }

  if (context.current !== undefined) {
    if (opts.workspace !== undefined && opts.workspace !== context.current.name) {
      throw new InvalidArgumentError(
        `--workspace "${opts.workspace}" does not match the current workspace "${context.current.name}". Run from the root to target a different workspace.`,
      );
    }
    return oneWorkspaceTarget(context, context.current);
  }

  if (opts.workspace !== undefined) {
    throw new InvalidArgumentError(
      `--workspace "${opts.workspace}" given but this project declares no workspaces.`,
    );
  }
  return singleTarget(context.root);
}

function hasMain(project: ResolvedProject): boolean {
  return typeof project.main === "string" && project.main.length > 0;
}

/** Target one workspace plus its `workspace:` dependency closure, in build order. */
function oneWorkspaceTarget(context: WorkspaceContext, node: WorkspaceNode): DevTarget {
  return {
    server: node.project,
    buildOrder: dependencyClosure(context, node.name).map((w) => w.project),
    plugins: hasMain(node.project) ? [node.project] : [],
  };
}

/** The named workspace plus every transitive `workspace:` dep, topologically sorted. */
function dependencyClosure(context: WorkspaceContext, name: string): WorkspaceNode[] {
  const byName = new Map(context.workspaces.map((w) => [w.name, w]));
  const needed = new Set<string>();
  const visit = (n: string): void => {
    if (needed.has(n)) return;
    const node = byName.get(n);
    if (node === undefined) return;
    needed.add(n);
    for (const dep of workspaceDependencyNames(node)) visit(dep);
  };
  visit(name);
  return topologicalOrder(context.workspaces.filter((w) => needed.has(w.name)));
}

function workspaceTable(nodes: WorkspaceNode[]): string {
  return nodes
    .map((w) => {
      const main = hasMain(w.project) ? w.project.main : "<no main>";
      const platforms = (w.project.compatibility?.platforms ?? []).join(", ") || "<no platforms>";
      return `  • ${w.name}: main=${main}; platforms=${platforms}`;
    })
    .join("\n");
}

/** Commander parser for `--debug <port>`; the value is only present when given. */
function parseDebug(value: string): number {
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new InvalidArgumentError(`--debug port must be 1–65535 (got "${value}")`);
  }
  return port;
}

/** Commander parser for `--fallback`; the three accepted hotswap-miss modes. */
function parseFallback(value: string): "manual" | "reload" | "restart" {
  if (value === "manual" || value === "reload" || value === "restart") return value;
  throw new InvalidArgumentError(
    `--fallback must be one of: manual, restart, reload (got "${value}")`,
  );
}

/** Factory for the `pluggy dev` commander command. */
export function devCommand(): Command {
  return new Command("dev")
    .description("Start a development server for the project.")
    .option(
      "--workspace <name>",
      "Target one workspace (only needed when shipping workspaces span platforms).",
    )
    .option("--platform <name>", "Override the primary platform.", parsePlatform)
    .option("--mc-version <version>", "Override the primary MC version.", parseMcVersion)
    .option("--port <n>", "Port the server listens on.", parseInteger)
    .option("--memory <x>", "JVM heap size (e.g. 2G, 512M).")
    .option("--clean", "Wipe dev/ before starting.")
    .option("--fresh-world", "Keep dev/ but delete dev/world*.")
    .option("--no-watch", "Run once, don't watch or rebuild.")
    .option(
      "--fallback <mode>",
      "What to do when a change can't be hotswapped: manual (default; notify and wait), restart, or reload.",
      parseFallback,
    )
    .option("--reload", "Legacy alias for --fallback reload (uses the deprecated /reload command).")
    .option("--no-hotswap", "Rebuild and restart the server on change instead of hotswapping.")
    .option(
      "--debug [port]",
      "Attach a JDWP debug agent for IDE breakpoints (default port 5005).",
      parseDebug,
    )
    .option("--debug-suspend", "With --debug, wait for a debugger to attach before starting.")
    .option(
      "--debug-expose",
      "Let a debugger on another machine attach. The debug port is unauthenticated: anything that can reach it can run code.",
    )
    .option("--offline", "Let accounts connect without Mojang authentication.")
    .action(async function action(this: Command, options) {
      const globalOpts = this.optsWithGlobals();
      await runDevCommand({
        workspace: options.workspace,
        platform: options.platform,
        mcVersion: options.mcVersion,
        port: options.port,
        memory: options.memory,
        clean: options.clean === true,
        freshWorld: options.freshWorld === true,
        // commander's `--no-watch` yields watch:false; absence yields true.
        watch: options.watch,
        reload: options.reload === true,
        fallback: options.fallback,
        // `--no-hotswap` → false; absence → undefined (let config decide).
        hotswap: options.hotswap === false ? false : undefined,
        // `--debug` → true, `--debug <port>` → number; --debug-suspend implies debug.
        debug: options.debug ?? (options.debugSuspend === true ? true : undefined),
        // Forward raw (undefined when absent) so project dev.debug.suspend can apply.
        debugSuspend: options.debugSuspend,
        debugExpose: options.debugExpose,
        offline: options.offline === true,
        project: globalOpts.project,
      });
    });
}
