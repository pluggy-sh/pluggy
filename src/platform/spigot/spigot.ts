import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { bukkitDescriptor } from "../descriptor/bukkit.ts";
import { createPlatform } from "../platform.ts";
import { BUKKIT_RUNTIME } from "../runtime.ts";
import { compile, versions, VERSIONS_URL } from "./buildtools.ts";

export default createPlatform((ctx) => ({
  id: "spigot",
  descriptor: bukkitDescriptor,
  runtime: BUKKIT_RUNTIME,

  async getVersionInfo(version: string) {
    const res = await fetch(`${VERSIONS_URL}${version}.json`);
    if (!res.ok) throw new Error(`Failed to fetch version info for ${version}: ${res.statusText}`);
    const data = (await res.json()) as { name?: number };
    if (!data || !data.name) throw new Error(`Invalid version info for ${version}`);
    return { version, build: data.name };
  },

  async getVersions() {
    return (await versions()).filter((version) => version.includes("."));
  },

  async getLatestVersion() {
    const versionsList = await this.getVersions();
    const latestVersion = versionsList[0];
    if (!latestVersion) throw new Error("No versions found for Spigot");
    return await this.getVersionInfo(latestVersion);
  },

  api(version) {
    return Promise.resolve({
      repositories: ["https://hub.spigotmc.org/nexus/content/repositories/snapshots/"],
      dependencies: [
        { groupId: "org.spigotmc", artifactId: "spigot-api", version: `${version}-R0.1-SNAPSHOT` },
      ],
    });
  },

  async download(version, ignoreCache = false) {
    const CACHE_PATH = ctx.getCachePath();
    const JAR_PATH = join(CACHE_PATH, "versions", `spigot-${version.version}-${version.build}.jar`);

    if (existsSync(JAR_PATH) && !ignoreCache) {
      return { ...version, output: new Uint8Array(readFileSync(JAR_PATH)) };
    }

    const compiler = await compile(ctx, version.version, "spigot", ignoreCache);
    const output = await compiler.output();

    await mkdir(join(CACHE_PATH, "versions"), { recursive: true });
    await writeFile(JAR_PATH, output);
    return { ...version, output };
  },
}));
