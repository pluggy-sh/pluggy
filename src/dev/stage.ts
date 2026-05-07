/**
 * Stage `<project>/dev/`: link the server jar, write `eula.txt`, render
 * `server.properties`, and honour `clean` / `freshWorld` semantics.
 * Text files are written LF-only.
 */

import { existsSync } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";

import { linkOrCopy, writeFileLF } from "../portable.ts";
import type { ResolvedProject } from "../project.ts";

export interface StageDevOptions {
  /** Wipe the entire `dev/` dir before staging. */
  clean?: boolean;
  /** Keep `dev/` but nuke every `dev/world*` subdir. */
  freshWorld?: boolean;
  /**
   * Optional override for `server-port` in `server.properties`. Otherwise
   * inherited from `project.dev.port`, falling back to 25565.
   */
  port?: number;
  /** Force online mode one way or another. Overrides `project.dev.onlineMode`. */
  onlineMode?: boolean;
  /**
   * Whether the platform runtime expects vanilla MC server files. When
   * `true` (paper/folia/spigot/bukkit/sponge) `eula.txt` and
   * `server.properties` are written; when `false` (velocity/bungee) both
   * are skipped — proxies don't read them.
   */
  vanillaServerFiles: boolean;
}

const EULA_HEADER =
  "# EULA auto-accepted by pluggy on your behalf. Set PLUGGY_DEV_NO_EULA=1 to manage this file yourself.\n" +
  "# See https://account.mojang.com/documents/minecraft_eula\n";

/**
 * Prepare `<project>/dev/` and return its absolute path. `clean` wipes the
 * directory first; `freshWorld` preserves everything except `world*` subdirs.
 */
export async function stageDev(
  project: ResolvedProject,
  platformJarPath: string,
  opts: StageDevOptions,
): Promise<string> {
  const devDir = resolve(project.rootDir, "dev");

  if (opts.clean === true) {
    await rm(devDir, { recursive: true, force: true });
  } else if (opts.freshWorld === true && existsSync(devDir)) {
    const entries = await readdir(devDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.startsWith("world")) {
        await rm(join(devDir, entry.name), { recursive: true, force: true });
      }
    }
  }

  await mkdir(devDir, { recursive: true });

  const serverJar = join(devDir, "server.jar");
  await linkOrCopy(platformJarPath, serverJar);

  if (opts.vanillaServerFiles) {
    if (process.env.PLUGGY_DEV_NO_EULA !== "1") {
      await writeFileLF(join(devDir, "eula.txt"), `${EULA_HEADER}eula=true\n`);
    }

    const serverProperties = renderServerProperties(project, opts);
    await writeFileLF(join(devDir, "server.properties"), serverProperties);
  }

  return devDir;
}

/**
 * Merge user `dev.serverProperties` with pluggy defaults. Defaults come
 * first in emit order, then any extra user keys in declaration order. User
 * values win on conflict.
 */
function renderServerProperties(project: ResolvedProject, opts: StageDevOptions): string {
  const dev = project.dev ?? {};
  const userProps = dev.serverProperties ?? {};
  const hasUser = (k: string): boolean => Object.prototype.hasOwnProperty.call(userProps, k);

  const online = opts.onlineMode !== undefined ? opts.onlineMode : (dev.onlineMode ?? false);
  const port = opts.port ?? dev.port ?? 25565;
  const motd = `${project.name} dev`;

  const defaults: Array<[string, string | number | boolean]> = [
    ["motd", motd],
    ["online-mode", online],
    ["server-port", port],
  ];

  const effective = new Map<string, string | number | boolean>();
  for (const [key, value] of defaults) {
    effective.set(key, hasUser(key) ? (userProps[key] as string | number | boolean) : value);
  }
  for (const [key, value] of Object.entries(userProps)) {
    if (!effective.has(key)) effective.set(key, value);
  }

  const out: string[] = [];
  for (const [key, value] of effective) {
    out.push(`${key}=${stringifyProp(value)}`);
  }
  return `${out.join("\n")}\n`;
}

function stringifyProp(v: string | number | boolean): string {
  return String(v);
}
