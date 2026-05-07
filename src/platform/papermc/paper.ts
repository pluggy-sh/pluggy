import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { bukkitDescriptor } from "../descriptor/bukkit.ts";
import { createPlatform, type Version } from "../platform.ts";
import { BUKKIT_RUNTIME } from "../runtime.ts";
import * as papermc from "./papermc.ts";

const PAPER_MAVEN_METADATA =
  "https://repo.papermc.io/repository/maven-public/io/papermc/paper/paper-api/maven-metadata.xml";

/**
 * Resolve an MC version (e.g. `"1.21.8"`, `"26.1.2"`) to the Maven
 * coordinate Paper publishes for `paper-api`.
 *
 * Paper has two formats in the wild:
 *   - Old SNAPSHOT form: `<mc>-R0.1-SNAPSHOT` (1.17 — 1.21.x)
 *   - New build-stamped form: `<mc>.build.<N>-alpha` (26.x+)
 *
 * The provider fetches Paper's top-level `maven-metadata.xml` and picks
 * the highest matching entry. Falls back to the old SNAPSHOT form when
 * no published artifact is found, so the Maven resolver can surface a
 * specific 404 instead of a cryptic "no match".
 */
async function resolvePaperApiVersion(mcVersion: string): Promise<string> {
  const res = await fetch(PAPER_MAVEN_METADATA);
  if (!res.ok) return `${mcVersion}-R0.1-SNAPSHOT`;
  const xml = await res.text();
  const all = Array.from(xml.matchAll(/<version>([^<]+)<\/version>/g), (m) => m[1]);

  const newFormat = all.filter((v) => v.startsWith(`${mcVersion}.build.`));
  if (newFormat.length > 0) {
    return newFormat.sort((a, b) => buildNumber(b) - buildNumber(a))[0];
  }

  const oldFormat = all.find((v) => v === `${mcVersion}-R0.1-SNAPSHOT`);
  if (oldFormat !== undefined) return oldFormat;

  return `${mcVersion}-R0.1-SNAPSHOT`;
}

function buildNumber(versionString: string): number {
  const match = versionString.match(/\.build\.(\d+)/);
  return match ? Number.parseInt(match[1], 10) : 0;
}

export default createPlatform((ctx) => ({
  id: "paper",
  descriptor: bukkitDescriptor,
  runtime: BUKKIT_RUNTIME,

  async getVersionInfo(version: string): Promise<Version> {
    const versionsList = await papermc.versions("paper");
    const versionInfo = versionsList.find((v) => v.version.id === version);
    if (!versionInfo) throw new Error(`Failed to fetch version info for ${version}`);
    return { version, build: versionInfo.builds[0] };
  },

  async getLatestVersion(): Promise<Version> {
    const versionsList = await papermc.versions("paper");
    if (versionsList.length === 0) throw new Error("No versions found for paper");
    const latestVersion = versionsList[0];
    return { version: latestVersion.version.id, build: latestVersion.builds[0] };
  },

  async getVersions(): Promise<string[]> {
    const versionsList = await papermc.versions("paper");
    return versionsList.map((v) => v.version.id);
  },

  async api(version: string) {
    const repo = "https://repo.papermc.io/repository/maven-public/";
    const resolved = await resolvePaperApiVersion(version);
    return {
      repositories: [repo],
      dependencies: [
        {
          groupId: "io.papermc.paper",
          artifactId: "paper-api",
          version: resolved,
        },
      ],
    };
  },

  async download(version: Version, ignoreCache = false) {
    const CACHE_PATH = ctx.getCachePath();
    const JAR_PATH = join(CACHE_PATH, "versions", `paper-${version.version}-${version.build}.jar`);

    if (existsSync(JAR_PATH) && !ignoreCache) {
      return {
        version: version.version,
        build: version.build,
        output: new Uint8Array(readFileSync(JAR_PATH)),
      };
    }

    const result = await papermc.download("paper", version.version, version.build);
    const output = new Uint8Array(result.output);

    await mkdir(join(CACHE_PATH, "versions"), { recursive: true });
    await writeFile(JAR_PATH, output);
    return { version: result.version, build: result.build, output };
  },
}));
