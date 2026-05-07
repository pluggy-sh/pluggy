import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { bungeeDescriptor } from "../descriptor/bungee.ts";
import { createPlatform, type Version } from "../platform.ts";
import { BUNGEE_RUNTIME } from "../runtime.ts";
import * as papermc from "./papermc.ts";

export default createPlatform((ctx) => ({
  id: "waterfall",
  descriptor: bungeeDescriptor,
  runtime: BUNGEE_RUNTIME,

  async getVersionInfo(version: string): Promise<Version> {
    const versionsList = await papermc.versions("waterfall");
    const versionInfo = versionsList.find((v) => v.version.id === version);
    if (!versionInfo) throw new Error(`Failed to fetch version info for ${version}`);
    return { version, build: versionInfo.builds[0] };
  },

  async getLatestVersion(): Promise<Version> {
    const versionsList = await papermc.versions("waterfall");
    if (versionsList.length === 0) throw new Error("No versions found for waterfall");
    const latestVersion = versionsList[0];
    return { version: latestVersion.version.id, build: latestVersion.builds[0] };
  },

  api(version) {
    return Promise.resolve({
      repositories: ["https://repo.papermc.io/repository/maven-public/"],
      dependencies: [
        {
          groupId: "io.github.waterfallmc",
          artifactId: "waterfall-api",
          version: `${version}-R0.1-SNAPSHOT`,
        },
      ],
    });
  },

  async getVersions(): Promise<string[]> {
    const versionsList = await papermc.versions("waterfall");
    return versionsList.map((v) => v.version.id);
  },

  async download(version: Version, ignoreCache = false) {
    const CACHE_PATH = ctx.getCachePath();
    const JAR_PATH = join(
      CACHE_PATH,
      "versions",
      `waterfall-${version.version}-${version.build}.jar`,
    );

    if (existsSync(JAR_PATH) && !ignoreCache) {
      return {
        version: version.version,
        build: version.build,
        output: new Uint8Array(readFileSync(JAR_PATH)),
      };
    }

    const result = await papermc.download("waterfall", version.version, version.build);
    const output = new Uint8Array(result.output);

    await mkdir(join(CACHE_PATH, "versions"), { recursive: true });
    await writeFile(JAR_PATH, output);
    return { version: result.version, build: result.build, output };
  },
}));
