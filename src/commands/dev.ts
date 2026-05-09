import { join } from "node:path";
import process from "node:process";

import { Command, InvalidArgumentError } from "commander";

import { runDev } from "../dev/index.ts";
import { bold, dim, emit, log } from "../logging.ts";
import type { ResolvedProject } from "../project.ts";
import { findWorkspace, resolveWorkspaceContext, type WorkspaceContext } from "../workspace.ts";

import { parseInteger, parsePlatform, parseSemver } from "./parsers.ts";

export interface DevCommandOptions {
  workspace?: string;
  platform?: string;
  version?: string;
  port?: number;
  memory?: string;
  clean?: boolean;
  freshWorld?: boolean;
  /** `--no-watch` → `false`; flag absence → `undefined` (treated as on). */
  watch?: boolean;
  reload?: boolean;
  /** `--no-hotswap` → `false`; flag absence → `undefined` (config decides). */
  hotswap?: boolean;
  offline?: boolean;
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
  const context = resolveWorkspaceContext(cwd);
  if (context === undefined) {
    throw new Error("No pluggy project found. Run this from inside a project directory.");
  }

  const target = selectDevTarget(context, opts);

  const platformId = opts.platform ?? target.compatibility?.platforms?.[0];
  const mcVersion = opts.version ?? target.compatibility?.versions?.[0];
  const port = opts.port ?? target.dev?.port ?? 25565;
  const devDir = join(target.rootDir, "dev");
  emit(
    {
      status: "starting",
      platform: platformId,
      version: mcVersion,
      port,
      devDir,
    },
    () => {
      log.heading(`Starting dev server for ${bold(target.name)}`);
      log.step(`platform ${dim(`${platformId} ${mcVersion}`)}, port ${port}`);
    },
  );

  await runDev(target, {
    platform: opts.platform,
    version: opts.version,
    port: opts.port,
    memory: opts.memory,
    clean: opts.clean,
    freshWorld: opts.freshWorld,
    watch: opts.watch,
    reload: opts.reload,
    hotswap: opts.hotswap,
    offline: opts.offline,
    args: target.dev?.jvmArgs,
  });
}

/**
 * Pick the single workspace `dev` targets.
 *
 * At a root with workspaces `--workspace` is required; inside a workspace it
 * must match (or be omitted); standalone projects use their root. `dev` has
 * no `--workspaces`: the dev server is always one-at-a-time.
 */
export function selectDevTarget(
  context: WorkspaceContext,
  opts: Pick<DevCommandOptions, "workspace">,
): ResolvedProject {
  if (context.atRoot && context.workspaces.length > 0) {
    if (opts.workspace === undefined) {
      throw new InvalidArgumentError(
        "dev requires --workspace <name> at a root that declares workspaces. " +
          `Known workspaces: ${context.workspaces.map((w) => w.name).join(", ")}`,
      );
    }
    return findWorkspace(context, opts.workspace).project;
  }

  if (context.current !== undefined) {
    if (opts.workspace !== undefined && opts.workspace !== context.current.name) {
      throw new InvalidArgumentError(
        `--workspace "${opts.workspace}" does not match the current workspace "${context.current.name}". Run from the root to target a different workspace.`,
      );
    }
    return context.current.project;
  }

  if (opts.workspace !== undefined) {
    throw new InvalidArgumentError(
      `--workspace "${opts.workspace}" given but this project declares no workspaces.`,
    );
  }
  return context.root;
}

/** Factory for the `pluggy dev` commander command. */
export function devCommand(): Command {
  return new Command("dev")
    .description("Start a development server for the project.")
    .option("--workspace <name>", "Required when run at a root with workspaces.")
    .option("--platform <name>", "Override the primary platform.", parsePlatform)
    .option("--version <ver>", "Override the primary MC version.", parseSemver)
    .option("--port <n>", "Server listen port.", parseInteger)
    .option("--memory <x>", "JVM heap size (for example, 2G, 512M).")
    .option("--clean", "Wipe dev/ before starting.")
    .option("--fresh-world", "Keep dev/ but delete dev/world*.")
    .option("--no-watch", "Run once, don't watch or rebuild.")
    .option("--reload", "Prefer /reload over a full restart when hotswap can't redefine a change.")
    .option("--no-hotswap", "Disable HotswapAgent + JBR; use /reload or restart only.")
    .option("--offline", "Set online-mode=false in server.properties.")
    .action(async function action(this: Command, options) {
      await runDevCommand({
        workspace: options.workspace,
        platform: options.platform,
        version: options.version,
        port: options.port,
        memory: options.memory,
        clean: options.clean === true,
        freshWorld: options.freshWorld === true,
        // commander's `--no-watch` yields watch:false; absence yields true.
        watch: options.watch,
        reload: options.reload === true,
        // `--no-hotswap` → false; absence → undefined (let config decide).
        hotswap: options.hotswap === false ? false : undefined,
        offline: options.offline === true,
      });
    });
}
