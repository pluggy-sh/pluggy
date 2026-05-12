/**
 * PaperMC fill.papermc.io client. Used by every PaperMC-family platform
 * provider (paper, folia, travertine, velocity, waterfall) to list
 * versions and download server jars.
 */

type Project = "paper" | "folia" | "travertine" | "velocity" | "waterfall";

const PAPER_ENDPOINT = "https://fill.papermc.io/v3/projects";

interface Version {
  version: {
    id: string;
    support: {
      status: "SUPPORTED" | "UNSUPPORTED";
    };
    java: {
      version: {
        minimum: number;
        maximum: number;
      };
      flags: {
        recommended: string[];
      };
    };
  };
  builds: number[];
}

/**
 * List every version of a PaperMC project that has at least one
 * published build, newest-first. Upstream sometimes publishes a
 * version entry before any build artifacts exist (e.g. Folia 26.1.2);
 * such entries are filtered out because they aren't downloadable.
 */
export function versions(project: Project): Promise<Version[]> {
  return fetch(`${PAPER_ENDPOINT}/${project}/versions`)
    .then((res) => res.json() as Promise<{ versions: Version[] }>)
    .then((data) => data.versions.filter((v) => v.builds.length > 0));
}

/**
 * Resolve a Minecraft version (e.g. `1.21.8`, `26.1.2`) to the Maven
 * coordinate published for a PaperMC artifact (paper-api, folia-api, …).
 *
 * Two formats coexist:
 *   - Old SNAPSHOT form: `<mc>-R0.1-SNAPSHOT` (used through 1.21.x)
 *   - New build-stamped form: `<mc>.build.<N>-<channel>` (26.x+)
 *
 * Fetches the artifact's top-level `maven-metadata.xml` and prefers the
 * highest build-stamped entry. Falls back to the SNAPSHOT form when no
 * build-stamped entry exists (or metadata isn't reachable) so the Maven
 * resolver surfaces a specific 404 instead of a cryptic "no match".
 */
export async function resolveApiVersion(metadataUrl: string, mcVersion: string): Promise<string> {
  const snapshotForm = `${mcVersion}-R0.1-SNAPSHOT`;
  const res = await fetch(metadataUrl);
  if (!res.ok) return snapshotForm;
  const xml = await res.text();
  const all = Array.from(xml.matchAll(/<version>([^<]+)<\/version>/g), (m) => m[1]);

  const buildStamped = all.filter((v) => v.startsWith(`${mcVersion}.build.`));
  if (buildStamped.length > 0) {
    return buildStamped.sort((a, b) => buildNumber(b) - buildNumber(a))[0];
  }

  return snapshotForm;
}

function buildNumber(versionString: string): number {
  const match = versionString.match(/\.build\.(\d+)/);
  return match ? Number.parseInt(match[1], 10) : 0;
}

/**
 * Download a specific build (or the latest build when `build` is omitted)
 * for `project`/`version` and return the bytes. `target` selects the
 * download channel (defaults to `server:default`).
 */
export async function download(
  project: Project,
  version: string,
  build?: number,
  target: string = "server:default",
): Promise<{
  version: string;
  build: number;
  output: ArrayBuffer;
}> {
  const res = await fetch(
    `${PAPER_ENDPOINT}/${project}/versions/${version}/builds${build ? `/${build}` : ""}`,
  );
  if (!res.ok)
    throw new Error(
      `Failed to download ${project} version ${version} build ${build}: ${res.statusText}`,
    );
  const data = (await res.json()) as
    | { downloads?: Record<string, { url: string }> }
    | Array<{ id: number; downloads: Record<string, { url: string }> }>;
  if (build) {
    const single = data as { downloads?: Record<string, { url: string }> };
    const url = single?.downloads?.[target]?.url;
    if (!url)
      throw new Error(
        `No download URL for ${project} version ${version} build ${build} target ${target}`,
      );
    const downloadRes = await fetch(url);
    if (!downloadRes.ok)
      throw new Error(
        `Failed to download ${project} version ${version} build ${build}: ${downloadRes.statusText}`,
      );
    return {
      version,
      build,
      output: await downloadRes.arrayBuffer(),
    };
  } else {
    const builds = (data as Array<{ id: number; downloads: Record<string, { url: string }> }>).sort(
      (a, b) => b.id - a.id,
    );
    if (builds.length === 0) throw new Error(`No builds found for ${project} version ${version}`);
    const latestBuild = builds[0];
    const downloadRes = await fetch(latestBuild.downloads[target].url);
    if (!downloadRes.ok)
      throw new Error(
        `Failed to download ${project} version ${version}: ${downloadRes.statusText}`,
      );
    return {
      version,
      build: latestBuild.id,
      output: await downloadRes.arrayBuffer(),
    };
  }
}
