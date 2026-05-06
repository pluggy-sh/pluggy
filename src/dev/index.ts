/**
 * Dev-server runtime — stage `dev/`, build, spawn the server, watch sources,
 * and on every debounced change try `hotswap → /reload → restart` in order.
 *
 * Hotswap is on by default: pluggy provisions JetBrains Runtime + HotswapAgent
 * into the user cache and points HA's `extraClasspath` at the build's
 * exploded `.class` directory, so subsequent javac runs reload classes
 * in-place. Falls back to `/reload confirm` (or full restart) when HA
 * reports it can't redefine, or when no marker arrives within the timeout.
 */

import { basename, join, resolve } from "node:path";

import { buildProject, projectStagingDir } from "../build/index.ts";
import { log } from "../logging.ts";
import { getPlatform } from "../platform/index.ts";
import type { DescriptorSpec } from "../platform/platform.ts";
import { linkOrCopy } from "../portable.ts";
import { getCachePath, type HotswapConfig, type ResolvedProject } from "../project.ts";
import { effectiveRegistries } from "../registry.ts";
import { resolveDependency, type ResolvedDependency } from "../resolver/index.ts";
import { ensureJdkForProject } from "../sdk/index.ts";
import { parseSource } from "../source.ts";

import {
  agentJvmArgs,
  ensureAgent,
  renderPropertiesFile,
  start as startHotswap,
  type HotswapWatcher,
} from "./hotswap.ts";
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
  reload?: boolean;
  offline?: boolean;
  args?: string[];
  /**
   * `false` disables hotswap entirely. `undefined` (the default) honours
   * `project.dev.hotswap` — which itself defaults to `true`.
   */
  hotswap?: boolean;
}

interface ResolvedHotswap {
  enabled: boolean;
  jdk: "jbr" | "system";
  fallback: "reload" | "restart";
}

/**
 * Run the dev loop: ensure platform jar, build plugin, stage `dev/`, spawn
 * server, and (unless `watch === false`) rebuild on source change. Returns
 * when the server has exited cleanly.
 */
export async function runDev(project: ResolvedProject, opts: DevOptions): Promise<void> {
  const platformId = opts.platform ?? project.compatibility.platforms[0];
  if (platformId === undefined) {
    throw new Error(
      "runDev: no platform configured — set compatibility.platforms[0] or pass --platform",
    );
  }
  const mcVersion = opts.version ?? project.compatibility.versions[0];
  if (mcVersion === undefined) {
    throw new Error(
      "runDev: no MC version configured — set compatibility.versions[0] or pass --version",
    );
  }

  const hotswap = resolveHotswap(project, opts);
  // `--reload` is the legacy explicit fallback knob. With hotswap on it tunes
  // the fallback; with hotswap off it forces /reload-instead-of-restart like
  // the old behaviour.
  const reloadOnly = opts.reload === true;

  const platform = getPlatform(platformId);

  // `platform.download` writes to `<cachePath>/versions/<id>-<ver>-<build>.jar`;
  // we reuse that on-disk path instead of the returned bytes.
  const versionInfo = await platform.getVersionInfo(mcVersion);
  const downloaded = await platform.download(versionInfo, false);
  const platformJarPath = join(
    getCachePath(),
    "versions",
    `${platform.id}-${downloaded.version}-${downloaded.build}.jar`,
  );

  // Kick off hotswap provisioning early — JBR is ~200MB on first run, so we
  // overlap it with the platform-jar download and the build.
  const provisioningPromise = hotswap.enabled
    ? provisionHotswap(hotswap)
    : Promise.resolve(undefined);

  // The properties file has to be inside the plugin JAR itself so HA scopes
  // `extraClasspath` to the plugin's classloader (parent classloaders stay
  // clean). The staging dir is deterministic, so we can pre-compute it and
  // ask the build to drop the file in before zipping.
  const buildExtras: Record<string, string> = {};
  if (hotswap.enabled) {
    buildExtras["hotswap-agent.properties"] = renderPropertiesFile({
      classesDir: projectStagingDir(project),
    });
  }

  let buildResult = await buildProject(project, {
    clean: opts.clean,
    extraStagingFiles: buildExtras,
  });

  const runtimePluginDeps = await resolveRuntimePluginDeps(project, platform.descriptor);

  const devDir = await stageDev(project, platformJarPath, {
    clean: opts.clean,
    freshWorld: opts.freshWorld,
    port: opts.port,
    onlineMode: opts.offline === true ? false : project.dev?.onlineMode,
  });

  const extraPluginsAbsolute = (project.dev?.extraPlugins ?? []).map((p) =>
    resolve(project.rootDir, p),
  );
  await stagePlugins(devDir, buildResult.outputPath, runtimePluginDeps, extraPluginsAbsolute);

  const memory = opts.memory ?? project.dev?.memory ?? "2G";
  const userJvmArgs = opts.args ?? project.dev?.jvmArgs ?? [];

  const provisioning = await provisioningPromise;

  let javaPath: string | undefined;
  let jvmArgs: string[] = [...userJvmArgs];
  if (provisioning !== undefined) {
    javaPath = provisioning.javaPath;
    jvmArgs = [...agentJvmArgs({ agentJarPath: provisioning.agentJarPath }), ...userJvmArgs];
    log.info("dev: hotswap on (HotswapAgent + JBR)");
  } else {
    // No hotswap → spawn the server with the project's pinned JDK. Without
    // this, dev would fall back to whatever `java` is on PATH and silently
    // mismatch the project's compatibility target.
    const jdk = await ensureJdkForProject(project);
    javaPath = jdk.javaPath;
  }

  let child = spawnServer({
    devDir,
    serverJarName: "server.jar",
    memory,
    jvmArgs,
    javaPath,
  });

  log.debug(`dev: server spawned (pid=${child.pid ?? "?"})`);

  let watcher: HotswapWatcher | undefined =
    hotswap.enabled === true ? startHotswap({ child }) : undefined;

  const pluginJarName = basename(buildResult.outputPath);
  const pluginDest = join(devDir, "plugins", pluginJarName);

  let stopWatching: (() => void) | undefined;

  const waitForExit = (c: typeof child): Promise<void> =>
    new Promise<void>((resolvePromise) => {
      c.once("exit", () => resolvePromise());
    });

  if (opts.watch !== false) {
    const restart = async (): Promise<void> => {
      watcher?.stop();
      watcher = undefined;
      if (child.stdin !== null && !child.stdin.destroyed && child.stdin.writable) {
        child.stdin.write("stop\n");
      }
      await waitForExit(child);
      try {
        await linkOrCopy(buildResult.outputPath, pluginDest);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`dev: could not replace plugin jar: ${msg}`);
      }
      child = spawnServer({
        devDir,
        serverJarName: "server.jar",
        memory,
        jvmArgs,
        javaPath,
      });
      log.debug(`dev: server respawned (pid=${child.pid ?? "?"})`);
      if (hotswap.enabled === true) watcher = startHotswap({ child });
    };

    const reloadInPlace = async (): Promise<boolean> => {
      try {
        await linkOrCopy(buildResult.outputPath, pluginDest);
        if (child.stdin !== null && !child.stdin.destroyed && child.stdin.writable) {
          child.stdin.write("reload confirm\n");
          return true;
        }
        return false;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`dev: reload failed: ${msg}`);
        return false;
      }
    };

    const rebuildAndReload = async (): Promise<void> => {
      log.info("dev: change detected — rebuilding…");
      // Arm the watcher *before* the rebuild starts. javac writes can land
      // before this function returns, and HA's filesystem watcher sometimes
      // emits `RELOAD` while we're still inside `buildProject` — without
      // arm(), those markers would be dropped before `wait()` subscribes.
      watcher?.arm();
      try {
        buildResult = await buildProject(project, { extraStagingFiles: buildExtras });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`dev: rebuild failed — keeping previous jar running: ${msg}`);
        return;
      }

      // Hotswap path: fastest, in-process class redefinition. Falls through
      // on `failed` (HA refused) or `timeout` (no marker — usually a non-class
      // change like plugin.yml).
      if (hotswap.enabled === true && watcher !== undefined) {
        const outcome = await watcher.wait();
        if (outcome === "reloaded") {
          log.success("dev: hotswap reloaded");
          return;
        }
        log.info(`dev: hotswap ${outcome} — falling back to ${hotswap.fallback}`);
      }

      if (reloadOnly || hotswap.fallback === "reload") {
        const ok = await reloadInPlace();
        if (ok) return;
        log.info("dev: /reload failed — restarting");
      }

      await restart();
    };

    stopWatching = watchProject(project, {
      debounceMs: 200,
      onChange: rebuildAndReload,
    });
  }

  try {
    // `child` is reassigned when a rebuild respawns; snapshot, wait, re-check.
    while (true) {
      const snapshot = child;
      await waitForExit(snapshot);
      if (child === snapshot) break;
    }
  } finally {
    watcher?.stop();
    stopWatching?.();
  }
}

interface Provisioning {
  javaPath: string;
  agentJarPath: string;
}

async function provisionHotswap(cfg: ResolvedHotswap): Promise<Provisioning> {
  const [javaPath, agentJarPath] = await Promise.all([
    cfg.jdk === "jbr" ? ensureJbr() : Promise.resolve("java"),
    ensureAgent(),
  ]);
  return { javaPath, agentJarPath };
}

function resolveHotswap(project: ResolvedProject, opts: DevOptions): ResolvedHotswap {
  const raw = project.dev?.hotswap;
  let cfg: HotswapConfig;
  let enabledFromProject: boolean;
  if (raw === false) {
    enabledFromProject = false;
    cfg = {};
  } else if (raw === true || raw === undefined) {
    enabledFromProject = true;
    cfg = {};
  } else {
    enabledFromProject = true;
    cfg = raw;
  }

  // CLI flag wins. `--no-hotswap` sets opts.hotswap === false.
  const enabled = opts.hotswap === false ? false : enabledFromProject;

  return {
    enabled,
    jdk: cfg.jdk ?? "jbr",
    fallback: cfg.fallback ?? "reload",
  };
}

async function resolveRuntimePluginDeps(
  project: ResolvedProject,
  descriptor: DescriptorSpec,
): Promise<ResolvedDependency[]> {
  const deps = project.dependencies;
  if (deps === undefined || deps === null) return [];

  const registries = effectiveRegistries(project.registries);

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
    });
    const isPlugin = await isRuntimePlugin(resolved.jarPath, descriptor);
    if (isPlugin) results.push(resolved);
  }
  return results;
}
