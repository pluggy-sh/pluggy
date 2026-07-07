import type { ChildProcess } from "node:child_process";
import { basename, join, resolve } from "node:path";

import { buildProject, devStagingDir, recompileClasses, type BuildResult } from "../build/index.ts";
import { dim, log } from "../logging.ts";
import { platforms } from "../platform/index.ts";
import type { DescriptorSpec } from "../platform/platform.ts";
import { linkOrCopy } from "../portable.ts";
import {
  getCachePath,
  primaryPlatform,
  primaryVersion,
  type DebugConfig,
  type ResolvedProject,
} from "../project.ts";
import { effectiveRegistries } from "../registry.ts";
import { resolveDependency, type ResolvedDependency } from "../resolver/index.ts";
import { ensureJdkForProject } from "../sdk/index.ts";
import { parseSource } from "../source.ts";
import { resolveWorkspaceContext } from "../workspace.ts";

import {
  agentJvmArgs,
  createControlServer,
  ensureDevAgent,
  watchedPackageFromMain,
} from "./agent.ts";
import { DEFAULT_DEBUG_PORT, jdwpArg, type ResolvedDebug } from "./debug.ts";
import { ensureJbr } from "./jbr.ts";
import { isRuntimePlugin, stagePlugins } from "./plugins.ts";
import { spawnServer } from "./spawn.ts";
import { stageDev } from "./stage.ts";
import { watchProject } from "./watch.ts";

export interface DevOptions {
  platform?: string;
  version?: string;
  port?: number;
  memory?: string;
  clean?: boolean;
  freshWorld?: boolean;
  watch?: boolean;
  /** Legacy alias for `fallback: "reload"`. */
  reload?: boolean;
  fallback?: "manual" | "reload" | "restart";
  offline?: boolean;
  args?: string[];
  /** `false` disables hotswap; `undefined` honours `project.dev.hotswap`. */
  hotswap?: boolean;
  /** `true` enables JDWP on the default port; a number sets the port. */
  debug?: boolean | number;
  debugSuspend?: boolean;
  /** Bind JDWP to all interfaces instead of loopback (container/WSL2 only). */
  debugExpose?: boolean;
}

/**
 * What `dev` runs: one server (from `server`) hosting every plugin in
 * `plugins`, with `buildOrder` naming every workspace to build first
 * (dependency before dependent) so each plugin's jar and its `workspace:` deps
 * exist. A standalone project or a single `--workspace` collapses to one plugin.
 */
export interface DevTarget {
  server: ResolvedProject;
  buildOrder: ResolvedProject[];
  plugins: ResolvedProject[];
}

/** Wrap a lone project as a single-plugin target (standalone / one workspace). */
export function singleTarget(project: ResolvedProject): DevTarget {
  const isPlugin = typeof project.main === "string" && project.main.length > 0;
  return { server: project, buildOrder: [project], plugins: isPlugin ? [project] : [] };
}

interface ResolvedHotswap {
  enabled: boolean;
  fallback: "manual" | "reload" | "restart";
}

/** How long to wait for the agent's reload reply before falling back. */
const RELOAD_TIMEOUT_MS = 8000;

/** One plugin sharing the dev server: its dev-build dir, jar, and staged path. */
interface PluginState {
  project: ResolvedProject;
  classesDir: string;
  buildResult: BuildResult;
  compileCtx: { classpath: string[]; javacPath: string };
  pluginDest: string;
}

/** Resolves when the dev server has exited (a clean stop, not a restart). */
export async function runDev(target: DevTarget, opts: DevOptions): Promise<void> {
  const { server, plugins } = target;
  const platformId = opts.platform ?? primaryPlatform(server);
  const mcVersion = opts.version ?? primaryVersion(server);

  const hotswap = resolveHotswap(server, opts);
  const watchMode = opts.watch !== false;

  const platform = platforms.get(platformId);

  const versionInfo = await platform.info(mcVersion);
  const downloaded = await platform.download(versionInfo, false);
  const platformJarPath = join(
    getCachePath(),
    "versions",
    `${platform.id}-${downloaded.version}-${downloaded.build}.jar`,
  );

  // Provisioning (a ~200MB JBR download on first run) overlaps the build below.
  const provisioningPromise = hotswap.enabled ? provisionHotswap() : Promise.resolve(undefined);

  // Build every workspace in dependency order so each plugin's jar and its
  // `workspace:` deps exist. Plugins compile into their own dev staging dir
  // (isolated from `pluggy build`/IDE builds so the agent redefines from a tree
  // nothing else touches); libraries build normally as compile-time deps.
  const pluginNames = new Set(plugins.map((p) => p.name));
  const states: PluginState[] = [];
  for (const proj of target.buildOrder) {
    if (pluginNames.has(proj.name)) {
      const classesDir = devStagingDir(proj);
      const buildResult = await buildProject(proj, { clean: opts.clean, stagingDir: classesDir });
      states.push({
        project: proj,
        classesDir,
        buildResult,
        compileCtx: { classpath: buildResult.classpath, javacPath: buildResult.javacPath },
        pluginDest: "",
      });
    } else {
      await buildProject(proj, { clean: opts.clean });
    }
  }

  const runtimePluginDeps = await resolveRuntimeDeps(plugins, server, platform.descriptor);

  const devDir = await stageDev(server, platformJarPath, {
    clean: opts.clean,
    freshWorld: opts.freshWorld,
    port: opts.port,
    onlineMode: opts.offline === true ? false : server.dev?.onlineMode,
    vanillaServerFiles: platform.runtime.vanillaServerFiles,
  });

  for (const s of states) {
    s.pluginDest = join(
      devDir,
      ...platform.runtime.pluginsDir.split("/"),
      basename(s.buildResult.outputPath),
    );
  }

  const extraPluginsAbsolute = (server.dev?.extraPlugins ?? []).map((p) =>
    resolve(server.rootDir, p),
  );
  if (states.length > 0) {
    // stagePlugins takes one "own" jar; the rest of the suite rides along as
    // extra plugin jars (same hardlink-or-copy, unique basenames).
    const [ownJar, ...moreJars] = states.map((s) => s.buildResult.outputPath);
    await stagePlugins(devDir, platform.runtime.pluginsDir, ownJar, runtimePluginDeps, [
      ...moreJars,
      ...extraPluginsAbsolute,
    ]);
  }

  const memory = opts.memory ?? server.dev?.memory ?? "2G";
  const userJvmArgs = opts.args ?? server.dev?.jvmArgs ?? [];

  const provisioning = await provisioningPromise;

  // One per session; the agent reconnects to it after a restart.
  const control = hotswap.enabled ? await createControlServer() : undefined;

  let javaPath: string | undefined;
  let jvmArgs: string[] = [...userJvmArgs];
  if (provisioning !== undefined && control !== undefined) {
    javaPath = provisioning.javaPath;
    const roots = states.map((s) => ({
      classesDir: s.classesDir,
      watchedPackage: watchedPackageFromMain(s.project.main),
    }));
    jvmArgs = [
      ...agentJvmArgs({
        agentJarPath: provisioning.agentJarPath,
        roots,
        port: control.port,
        token: control.token,
      }),
      ...userJvmArgs,
    ];
    const scopes = roots
      .map((r) => r.watchedPackage)
      .filter((p): p is string => p !== undefined)
      .join(", ");
    log.step(`Hotswap enabled (JBR + agent${scopes.length > 0 ? ` · ${scopes}` : ""})`);
  } else {
    // Without a pinned JDK, dev would run on whatever `java` is on PATH and
    // silently mismatch the project's compatibility target.
    const jdk = await ensureJdkForProject(server);
    javaPath = jdk.javaPath;
  }

  const debug = resolveDebug(server, opts);
  if (debug.enabled) {
    jvmArgs = [jdwpArg(debug), ...jvmArgs];
    const host = debug.exposed ? "0.0.0.0" : "localhost";
    log.step(
      debug.suspend
        ? `Debug: waiting for a debugger to attach on ${host}:${debug.port}`
        : `Debug: attach a debugger on ${host}:${debug.port}`,
    );
    if (debug.exposed) {
      log.step(
        `Debug: JDWP is bound to all interfaces and unauthenticated — trusted networks only`,
      );
    }
  }

  // `manageStdin: false` hands stdin to the dev loop so it can intercept
  // `restart`; the spawner otherwise pipes it straight to the server console.
  let child = spawnServer({
    devDir,
    serverJarName: "server.jar",
    memory,
    jvmArgs,
    serverArgs: platform.runtime.serverArgs,
    javaPath,
    manageStdin: !watchMode,
  });

  log.debug(`server spawned (pid=${child.pid ?? "?"})`);

  const port = opts.port ?? server.dev?.port ?? 25565;
  announceWhenReady(child, port, watchMode);

  let stopWatching: (() => void) | undefined;
  let disposeStdin: (() => void) | undefined;
  let activeRestartRef: (() => Promise<void> | undefined) | undefined;

  const waitForExit = (c: typeof child): Promise<void> =>
    new Promise<void>((resolvePromise) => {
      c.once("exit", () => resolvePromise());
    });

  if (opts.watch !== false) {
    // Set while a restart is in flight; the main wait loop consults it so a
    // deliberate stop + respawn isn't mistaken for the session ending before
    // `restart()` has reassigned `child`.
    let activeRestart: Promise<void> | undefined;

    // Rebuild every plugin's jar and re-stage it. Used by the paths that reload
    // the jar from disk (restart, in-place reload), since a hotswap only
    // refreshes `.class` files and leaves the staged jar stale.
    const rebuildAllJars = async (): Promise<boolean> => {
      let ok = true;
      for (const s of states) {
        try {
          s.buildResult = await buildProject(s.project, { stagingDir: s.classesDir });
          s.compileCtx.classpath = s.buildResult.classpath;
          s.compileCtx.javacPath = s.buildResult.javacPath;
          await linkOrCopy(s.buildResult.outputPath, s.pluginDest);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.error(`Build failed for ${s.project.name}: ${msg}`);
          ok = false;
        }
      }
      return ok;
    };

    const restart = async (): Promise<void> => {
      if (child.stdin !== null && !child.stdin.destroyed && child.stdin.writable) {
        child.stdin.write("stop\n");
      }
      await waitForExit(child);
      await rebuildAllJars();
      child = spawnServer({
        devDir,
        serverJarName: "server.jar",
        memory,
        jvmArgs,
        serverArgs: platform.runtime.serverArgs,
        javaPath,
        manageStdin: false,
      });
      log.debug(`server respawned (pid=${child.pid ?? "?"})`);
    };

    const startRestart = (): Promise<void> => {
      const p = restart().finally(() => {
        if (activeRestart === p) activeRestart = undefined;
      });
      activeRestart = p;
      return p;
    };

    // `restart` (alias `rs`) is intercepted; every other line is forwarded to
    // the current child's console.
    let stdinBuffer = "";
    const onStdin = (chunk: Buffer | string): void => {
      stdinBuffer += chunk.toString();
      let nl = stdinBuffer.indexOf("\n");
      while (nl !== -1) {
        const line = stdinBuffer.slice(0, nl);
        stdinBuffer = stdinBuffer.slice(nl + 1);
        const cmd = line.trim().toLowerCase();
        if (cmd === "restart" || cmd === "rs") {
          if (activeRestart === undefined) {
            log.info(dim("· restarting the server..."));
            void startRestart();
          }
        } else if (child.stdin !== null && !child.stdin.destroyed && child.stdin.writable) {
          child.stdin.write(`${line}\n`);
        }
        nl = stdinBuffer.indexOf("\n");
      }
    };
    process.stdin.on("data", onStdin);
    disposeStdin = (): void => {
      process.stdin.removeListener("data", onStdin);
      process.stdin.pause();
    };

    const reloadInPlace = async (): Promise<boolean> => {
      // Modern Paper made `reload` standalone (it rejects `reload confirm`).
      if (!(await rebuildAllJars())) return false;
      if (child.stdin !== null && !child.stdin.destroyed && child.stdin.writable) {
        child.stdin.write("reload\n");
        return true;
      }
      return false;
    };

    // Recompile the one plugin that changed and hotswap it into the running
    // server; the agent redefines from every root, but only its classes moved.
    const rebuildAndReload = async (state: PluginState): Promise<void> => {
      try {
        await recompileClasses(state.project, {
          ...state.compileCtx,
          stagingDir: state.classesDir,
        });
      } catch {
        // compileJava already streamed the javac error to the console.
        log.error("compile error");
        log.info(dim("server still running with the previous code — fix the error and save again"));
        return;
      }

      if (control !== undefined) {
        const result = await control.reload(RELOAD_TIMEOUT_MS);
        if (result.status === "reloaded") {
          const n = result.count ?? 0;
          log.success(`hotswapped ${n} class${n === 1 ? "" : "es"}`);
          return;
        }
        if (result.status === "nochange") {
          log.info(dim("· no class changes; nothing to hotswap"));
          return;
        }
        if (result.status === "pending") {
          log.info(dim("· restart to apply new code"));
          return;
        }
      }

      if (hotswap.fallback === "reload") {
        if (await reloadInPlace()) return;
        log.info(dim("· restarting the server..."));
        await startRestart();
        return;
      }
      if (hotswap.fallback === "restart") {
        await startRestart();
        return;
      }
      log.info(dim("· restart to apply"));
    };

    const disposers = states.map((s) =>
      watchProject(s.project, { debounceMs: 200, onChange: () => rebuildAndReload(s) }),
    );
    stopWatching = (): void => {
      for (const d of disposers) d();
    };

    const onSave = hotswap.enabled
      ? "hotswapped into the running server"
      : hotswap.fallback === "reload"
        ? "rebuilt and applied with /reload"
        : hotswap.fallback === "restart"
          ? "rebuilt; the server restarts"
          : "rebuilt; type `restart` to apply";
    log.step(`Watching for changes — saves are ${onSave}`);

    activeRestartRef = (): Promise<void> | undefined => activeRestart;
  }

  try {
    // `child` is reassigned on respawn; if a restart is in flight when the old
    // child exits, wait for it rather than treating exit as session-end.
    while (true) {
      const snapshot = child;
      await waitForExit(snapshot);
      const pending = activeRestartRef?.();
      if (pending !== undefined) {
        await pending;
        continue;
      }
      if (child === snapshot) break;
    }
  } finally {
    control?.close();
    stopWatching?.();
    disposeStdin?.();
  }
}

/**
 * Print connect/stop affordances once the server logs its ready line
 * ("Done (…s)!" on bukkit-family/Sponge/Velocity, "Listening on" on Bungee).
 * Partial chunks are buffered so a ready line split across reads still
 * matches; the listener detaches after the first match. On a platform with
 * other wording the block simply never prints.
 */
function announceWhenReady(child: ChildProcess, port: number, watchMode: boolean): void {
  const stdout = child.stdout;
  if (stdout === null || stdout === undefined) return;
  let tail = "";
  const onData = (chunk: Buffer | string): void => {
    tail += chunk.toString();
    if (!/Done \(|Listening on /.test(tail)) {
      const lastNewline = tail.lastIndexOf("\n");
      tail = lastNewline === -1 ? tail.slice(-256) : tail.slice(lastNewline + 1);
      return;
    }
    stdout.removeListener("data", onData);
    log.info("");
    log.success(`Server ready on localhost:${port}`);
    log.step(`Connect: Minecraft → Multiplayer → Direct Connect → localhost:${port}`);
    if (watchMode) {
      log.step("Console: type server commands below; `restart` (or `rs`) restarts the server");
    }
    log.step("Ctrl+C to stop");
  };
  stdout.on("data", onData);
}

interface Provisioning {
  javaPath: string;
  agentJarPath: string;
}

async function provisionHotswap(): Promise<Provisioning> {
  const [javaPath, agentJarPath] = await Promise.all([ensureJbr(), ensureDevAgent()]);
  return { javaPath, agentJarPath };
}

/** Resolve JDWP debug settings from `--debug`/`--debug-suspend` and project config. */
export function resolveDebug(project: ResolvedProject, opts: DevOptions): ResolvedDebug {
  const raw = project.dev?.debug;
  let cfg: DebugConfig;
  let enabledFromProject: boolean;
  if (raw === undefined || raw === false) {
    enabledFromProject = false;
    cfg = {};
  } else if (raw === true) {
    enabledFromProject = true;
    cfg = {};
  } else if (typeof raw === "number") {
    enabledFromProject = true;
    cfg = { port: raw };
  } else {
    enabledFromProject = true;
    cfg = raw;
  }

  const enabled = opts.debug !== undefined ? opts.debug !== false : enabledFromProject;
  const port = typeof opts.debug === "number" ? opts.debug : (cfg.port ?? DEFAULT_DEBUG_PORT);
  const suspend = opts.debugSuspend ?? cfg.suspend ?? false;
  const exposed = opts.debugExpose ?? cfg.exposed ?? false;

  return { enabled, port, suspend, exposed };
}

function resolveHotswap(project: ResolvedProject, opts: DevOptions): ResolvedHotswap {
  const enabled = opts.hotswap === false ? false : project.dev?.hotswap !== false;

  const explicitFallback =
    opts.fallback ?? (opts.reload === true ? "reload" : undefined) ?? project.dev?.fallback;
  // Default `manual` with hotswap (an unprompted restart is disruptive), but
  // `restart` without it, since then every change needs one anyway.
  const fallback = explicitFallback ?? (enabled ? "manual" : "restart");

  return { enabled, fallback };
}

/**
 * Runtime-plugin deps across every plugin sharing the server, deduped by jar
 * basename (a sibling plugin declared as a `workspace:` dep only stages once).
 * Falls back to the server project when there are no plugins.
 */
async function resolveRuntimeDeps(
  plugins: ResolvedProject[],
  server: ResolvedProject,
  descriptor: DescriptorSpec,
): Promise<ResolvedDependency[]> {
  const sources = plugins.length > 0 ? plugins : [server];
  const seen = new Set<string>();
  const out: ResolvedDependency[] = [];
  for (const proj of sources) {
    for (const dep of await resolveRuntimePluginDeps(proj, descriptor)) {
      const key = basename(dep.jarPath);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(dep);
    }
  }
  return out;
}

async function resolveRuntimePluginDeps(
  project: ResolvedProject,
  descriptor: DescriptorSpec,
): Promise<ResolvedDependency[]> {
  const deps = project.dependencies;
  if (deps === undefined || deps === null) return [];

  const registries = effectiveRegistries(project.registries);
  // A plugin in a suite can declare a `workspace:` dep on a sibling; resolving
  // it needs the same WorkspaceContext the classpath build walks up to find.
  const workspaceContext = resolveWorkspaceContext(project.rootDir);

  const results: ResolvedDependency[] = [];
  for (const [name, raw] of Object.entries(deps)) {
    const { source, version } =
      typeof raw === "string"
        ? { source: `modrinth:${name}`, version: raw }
        : { source: raw.source, version: raw.version };
    const parsed = parseSource(source, version);
    const resolved = await resolveDependency(parsed, {
      rootDir: project.rootDir,
      includePrerelease: false,
      force: false,
      registries,
      workspaceContext,
    });
    const isPlugin = await isRuntimePlugin(resolved.jarPath, descriptor);
    if (isPlugin) results.push(resolved);
  }
  return results;
}
