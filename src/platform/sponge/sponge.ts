import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { spongeDescriptor } from "../descriptor/sponge.ts";
import { createPlatform, type Version } from "../platform.ts";
import { SPONGE_RUNTIME } from "../runtime.ts";

/**
 * SpongeVanilla, the standalone server flavour of Sponge. (SpongeForge and
 * SpongeNeo are mod-loader variants and live on top of Forge/NeoForge; pluggy
 * doesn't model modding, so they're intentionally out of scope.)
 *
 * Versioning is two-axis: every SpongeVanilla artifact carries both a
 * Minecraft version and a SpongeAPI version. The artifact key encodes both
 * (`<mc>-<api>-RC<n>`), and the dl-api exposes them via `tagValues`. Pluggy's
 * `compatibility.versions` is always Minecraft, so this provider surfaces
 * MC versions and resolves the matching SpongeAPI/SpongeVanilla artifact
 * internally; same pattern as the velocity provider.
 */

const ARTIFACT_BASE =
  "https://dl-api.spongepowered.org/v2/groups/org.spongepowered/artifacts/spongevanilla";
const SPONGE_REPO = "https://repo.spongepowered.org/repository/maven-public/";

interface ArtifactSummary {
  recommended: boolean;
  tagValues: { api: string; minecraft: string };
}

interface VersionsResponse {
  artifacts: Record<string, ArtifactSummary>;
  offset: number;
  limit: number;
  size: number;
}

interface ArtifactMetadata {
  tags?: { minecraft?: string[]; api?: string[] };
}

interface Asset {
  classifier?: string;
  extension: string;
  downloadUrl: string;
}

interface VersionDetail {
  assets: Asset[];
}

/** Version key produced by the Sponge dl-api, e.g. `1.21.8-12.0.0-RC2627`. */
interface ResolvedArtifact {
  key: string;
  api: string;
  minecraft: string;
  build: number;
}

/** Pull `RC<n>` off the end of a version key. Stable releases have no RC. */
function buildOf(key: string): number {
  const match = key.match(/-RC(\d+)$/);
  return match ? parseInt(match[1], 10) : 0;
}

function isStableMc(mc: string): boolean {
  return !mc.includes("snapshot") && !mc.includes("pre") && /^\d+(\.\d+)+/.test(mc);
}

/**
 * Walk the dl-api versions endpoint newest-first and yield artifacts that
 * pass `predicate`, stopping once `limit` matches are collected or the
 * dataset is exhausted. The artifact list runs into the thousands, so the
 * scanner pages and bails early; never fetching more than it needs.
 */
async function findArtifacts(
  predicate: (a: ResolvedArtifact) => boolean,
  limit: number,
): Promise<ResolvedArtifact[]> {
  const results: ResolvedArtifact[] = [];
  const PAGE = 100;
  let offset = 0;
  let total = Infinity;

  while (results.length < limit && offset < total) {
    const res = await fetch(`${ARTIFACT_BASE}/versions?limit=${PAGE}&offset=${offset}`);
    if (!res.ok) {
      throw new Error(`Failed to list spongevanilla versions: ${res.statusText}`);
    }
    const data = (await res.json()) as VersionsResponse;
    total = data.size;

    for (const [key, summary] of Object.entries(data.artifacts)) {
      const artifact: ResolvedArtifact = {
        key,
        api: summary.tagValues.api,
        minecraft: summary.tagValues.minecraft,
        build: buildOf(key),
      };
      if (predicate(artifact)) {
        results.push(artifact);
        if (results.length >= limit) break;
      }
    }

    offset += PAGE;
  }

  return results;
}

async function findArtifactByMcAndBuild(
  mcVersion: string,
  build: number,
): Promise<ResolvedArtifact> {
  const matches = await findArtifacts((a) => a.minecraft === mcVersion && a.build === build, 1);
  if (matches.length === 0) {
    throw new Error(`No SpongeVanilla artifact for MC ${mcVersion} build ${build}`);
  }
  return matches[0];
}

async function findLatestArtifactForMc(mcVersion: string): Promise<ResolvedArtifact> {
  const matches = await findArtifacts(
    (a) => a.minecraft === mcVersion && isStableMc(a.minecraft),
    1,
  );
  if (matches.length === 0) {
    throw new Error(`No SpongeVanilla artifact found for MC ${mcVersion}`);
  }
  return matches[0];
}

/**
 * SpongeAPI tags from the dl-api (e.g. `19.0.0`) often outpace what's
 * published as a release on the Maven repo. Anything past the current
 * `<release>` only exists as `<api>-SNAPSHOT`. Probe the spongeapi
 * `maven-metadata.xml` and pick the matching variant; fall back to the raw
 * tag so the Maven resolver can surface a precise 404 if the metadata fetch
 * itself fails.
 */
async function resolvePublishedApiVersion(api: string): Promise<string> {
  try {
    const res = await fetch(`${SPONGE_REPO}org/spongepowered/spongeapi/maven-metadata.xml`);
    if (!res.ok) return api;
    const xml = await res.text();
    const versions = new Set(Array.from(xml.matchAll(/<version>([^<]+)<\/version>/g), (m) => m[1]));
    if (versions.has(api)) return api;
    if (versions.has(`${api}-SNAPSHOT`)) return `${api}-SNAPSHOT`;
    return api;
  } catch {
    return api;
  }
}

export default createPlatform((ctx) => ({
  id: "sponge",
  descriptor: spongeDescriptor,
  runtime: SPONGE_RUNTIME,

  async versions(): Promise<string[]> {
    const res = await fetch(ARTIFACT_BASE);
    if (!res.ok) {
      throw new Error(`Failed to fetch spongevanilla metadata: ${res.statusText}`);
    }
    const data = (await res.json()) as ArtifactMetadata;
    const mcs = data.tags?.minecraft ?? [];
    return mcs.filter(isStableMc);
  },

  async info(mcVersion: string): Promise<Version> {
    const artifact = await findLatestArtifactForMc(mcVersion);
    return { version: artifact.minecraft, build: artifact.build };
  },

  async latest(): Promise<Version> {
    const matches = await findArtifacts((a) => isStableMc(a.minecraft), 1);
    if (matches.length === 0) {
      throw new Error("No SpongeVanilla artifacts available");
    }
    return { version: matches[0].minecraft, build: matches[0].build };
  },

  async api(mcVersion: string) {
    const artifact = await findLatestArtifactForMc(mcVersion);
    const version = await resolvePublishedApiVersion(artifact.api);
    return {
      repositories: [SPONGE_REPO],
      dependencies: [
        {
          groupId: "org.spongepowered",
          artifactId: "spongeapi",
          version,
        },
      ],
    };
  },

  async download(version: Version, ignoreCache = false) {
    const CACHE_PATH = ctx.getCachePath();
    const JAR_PATH = join(CACHE_PATH, "versions", `sponge-${version.version}-${version.build}.jar`);

    if (existsSync(JAR_PATH) && !ignoreCache) {
      return {
        version: version.version,
        build: version.build,
        output: new Uint8Array(readFileSync(JAR_PATH)),
      };
    }

    const artifact =
      version.build > 0
        ? await findArtifactByMcAndBuild(version.version, version.build)
        : await findLatestArtifactForMc(version.version);

    const detailRes = await fetch(`${ARTIFACT_BASE}/versions/${artifact.key}`);
    if (!detailRes.ok) {
      throw new Error(
        `Failed to fetch SpongeVanilla version ${artifact.key}: ${detailRes.statusText}`,
      );
    }
    const detail = (await detailRes.json()) as VersionDetail;
    const universal = detail.assets.find(
      (a) => a.classifier === "universal" && a.extension === "jar",
    );
    if (!universal) {
      throw new Error(`No universal jar published for SpongeVanilla ${artifact.key}`);
    }

    const jarRes = await fetch(universal.downloadUrl);
    if (!jarRes.ok) {
      throw new Error(`Failed to download SpongeVanilla ${artifact.key}: ${jarRes.statusText}`);
    }
    const output = new Uint8Array(await jarRes.arrayBuffer());

    await mkdir(join(CACHE_PATH, "versions"), { recursive: true });
    await writeFile(JAR_PATH, output);

    return { version: artifact.minecraft, build: artifact.build, output };
  },
}));
