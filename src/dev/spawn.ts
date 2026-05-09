/**
 * Spawn the Minecraft server JVM inside the staged dev directory. stdin is
 * piped so the parent can send `/stop`; stdout/stderr are piped through to
 * the parent's terminal so the user still sees logs unchanged, while
 * remaining tap-able for the hotswap watcher.
 */

import { spawn, type ChildProcess } from "node:child_process";
import process from "node:process";

import { installShutdownHandler } from "../portable.ts";

export interface SpawnServerOptions {
  devDir: string;
  serverJarName: string;
  memory: string;
  /** Caller-supplied JVM flags. `-javaagent:` etc. go here. */
  jvmArgs: string[];
  /**
   * Args appended after `-jar <serverJar>`. Comes from the platform's
   * `runtime.serverArgs`. `["nogui"]` for bukkit-family, `["--nogui"]`
   * for sponge (ModLauncher), `[]` for velocity/bungee proxies.
   */
  serverArgs: string[];
  /**
   * Absolute path to the `java` binary to launch. Defaults to "java" on
   * PATH; the dev loop overrides this with a JBR-resolved path when hotswap
   * is enabled.
   */
  javaPath?: string;
}

/**
 * Spawn `<javaPath> -Xmx<memory> <jvmArgs> -jar <serverJar> <serverArgs>`
 * inside `devDir`. Installs a SIGINT handler that is disposed automatically
 * on child exit.
 */
export function spawnServer(opts: SpawnServerOptions): ChildProcess {
  const argv = [
    `-Xmx${opts.memory}`,
    ...opts.jvmArgs,
    "-jar",
    opts.serverJarName,
    ...opts.serverArgs,
  ];

  const child = spawn(opts.javaPath ?? "java", argv, {
    cwd: opts.devDir,
    stdio: ["pipe", "pipe", "pipe"],
  });

  // Forward server output to the parent terminal. The hotswap watcher can
  // attach additional `data` listeners; Node streams broadcast to all
  // listeners, so taps and the forward coexist.
  child.stdout?.pipe(process.stdout, { end: false });
  child.stderr?.pipe(process.stderr, { end: false });

  if (child.stdin !== null && !child.stdin.destroyed) {
    // `end: false` keeps the child's stdin open when the parent's closes
    // (for example, EOF on a non-TTY). Shutdown still reaches the child via the
    // SIGINT handler installed below.
    process.stdin.pipe(child.stdin, { end: false });
  }

  const dispose = installShutdownHandler(child, {
    gracefulStdin: "stop\n",
    graceMs: 30_000,
    forceKillWindowMs: 2_000,
  });

  child.once("exit", () => {
    dispose();
    if (child.stdin !== null) {
      try {
        process.stdin.unpipe(child.stdin);
      } catch {
        // Already unpiped or parent stdin is closed.
      }
    }
  });

  return child;
}
