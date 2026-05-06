import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { velocityDescriptor } from "../descriptor/velocity.ts";
import { createPlatform, type Version } from "../platform.ts";
import * as papermc from "./papermc.ts";

/**
 * Velocity is a proxy, not a server — a plugin built against
 * `velocity-api:3.4.0` works with any Minecraft protocol the running proxy
 * supports. Pluggy's `compatibility.versions` field represents Minecraft
 * versions across the whole tool, though, so this provider surfaces MC
 * versions (borrowed from Paper's list) to the user and resolves the
 * actual `velocity-api` coordinate internally when downloading or
 * generating Maven deps.
 */
async function latestVelocityRelease(): Promise<{ id: string; build: number }> {
  const list = await papermc.versions("velocity");
  if (list.length === 0) throw new Error("No velocity releases found");
  const stable = list.find((v) => !v.version.id.endsWith("-SNAPSHOT")) ?? list[0];
  return { id: stable.version.id, build: stable.builds[0] };
}

export default createPlatform((ctx) => ({
  id: "velocity",
  descriptor: velocityDescriptor,

  async getVersions(): Promise<string[]> {
    const mc = await papermc.versions("paper");
    return mc.map((v) => v.version.id);
  },

  async getVersionInfo(mcVersion: string): Promise<Version> {
    const release = await latestVelocityRelease();
    return { version: mcVersion, build: release.build };
  },

  async getLatestVersion(): Promise<Version> {
    const mc = await papermc.versions("paper");
    if (mc.length === 0) throw new Error("No versions found for velocity");
    const release = await latestVelocityRelease();
    return { version: mc[0].version.id, build: release.build };
  },

  async api(_mcVersion) {
    const release = await latestVelocityRelease();
    return {
      repositories: ["https://repo.papermc.io/repository/maven-public/"],
      dependencies: [
        { groupId: "com.velocitypowered", artifactId: "velocity-api", version: release.id },
      ],
    };
  },

  async download(version: Version, ignoreCache = false) {
    const CACHE_PATH = ctx.getCachePath();
    const release = await latestVelocityRelease();
    const JAR_PATH = join(
      CACHE_PATH,
      "versions",
      `velocity-${version.version}-${release.build}.jar`,
    );

    if (existsSync(JAR_PATH) && !ignoreCache) {
      return {
        version: version.version,
        build: release.build,
        output: new Uint8Array(readFileSync(JAR_PATH)),
      };
    }

    const result = await papermc.download("velocity", release.id, release.build);
    const output = new Uint8Array(result.output);

    await mkdir(join(CACHE_PATH, "versions"), { recursive: true });
    await writeFile(JAR_PATH, output);
    return { version: version.version, build: release.build, output };
  },
}));
