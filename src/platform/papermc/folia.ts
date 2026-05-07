import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { bukkitDescriptor } from "../descriptor/bukkit.ts";
import { createPlatform, type Version } from "../platform.ts";
import { BUKKIT_RUNTIME } from "../runtime.ts";
import * as papermc from "./papermc.ts";

export default createPlatform((ctx) => ({
  id: "folia",
  descriptor: bukkitDescriptor,
  runtime: BUKKIT_RUNTIME,

  async getVersionInfo(version: string): Promise<Version> {
    const versionsList = await papermc.versions("folia");
    const versionInfo = versionsList.find((v) => v.version.id === version);
    if (!versionInfo) throw new Error(`Failed to fetch version info for ${version}`);
    return { version, build: versionInfo.builds[0] };
  },

  async getLatestVersion(): Promise<Version> {
    const versionsList = await papermc.versions("folia");
    if (versionsList.length === 0) throw new Error("No versions found for folia");
    const latestVersion = versionsList[0];
    return { version: latestVersion.version.id, build: latestVersion.builds[0] };
  },

  async getVersions(): Promise<string[]> {
    const versionsList = await papermc.versions("folia");
    return versionsList.map((v) => v.version.id);
  },

  api(version) {
    return Promise.resolve({
      repositories: ["https://repo.papermc.io/repository/maven-public/"],
      dependencies: [
        { groupId: "dev.folia", artifactId: "folia-api", version: `${version}-R0.1-SNAPSHOT` },
      ],
    });
  },

  async download(version: Version, ignoreCache = false) {
    const CACHE_PATH = ctx.getCachePath();
    const JAR_PATH = join(CACHE_PATH, "versions", `folia-${version.version}-${version.build}.jar`);

    if (existsSync(JAR_PATH) && !ignoreCache) {
      return {
        version: version.version,
        build: version.build,
        output: new Uint8Array(readFileSync(JAR_PATH)),
      };
    }

    const result = await papermc.download("folia", version.version, version.build);
    const output = new Uint8Array(result.output);

    await mkdir(join(CACHE_PATH, "versions"), { recursive: true });
    await writeFile(JAR_PATH, output);
    return { version: result.version, build: result.build, output };
  },
}));
