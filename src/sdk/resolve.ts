/**
 * Map a project's MC version + platform to the Java major release pluggy
 * should provision. Two sources, in order:
 *
 *   1. `project.jdk.major` — explicit user pin, highest priority.
 *   2. Spigot's per-version manifest (`getJavaRange`) — keyed by MC version,
 *      authoritative for any platform targeting that MC version since the
 *      runtime requirement is set by the server, not the API flavor.
 *   3. Hardcoded heuristic — fallback when Spigot's hub is unreachable or
 *      the version is too new/snapshot to be indexed.
 *
 * We pick the **minimum** Java in the manifest range. Compiling against a
 * lower target keeps class files loadable by the MC server's runtime; a
 * later JDK can be installed manually if the user wants newer language
 * features and accepts the corresponding `--release` discipline.
 */

import { getJavaRange } from "../platform/spigot/buildtools.ts";
import type { ResolvedProject } from "../project.ts";
import {
  DEFAULT_DISTRIBUTION as DEFAULT_DISTRIBUTION_SLUG,
  validateDistribution,
  validateJavaMajor,
} from "./distributions.ts";

/**
 * Hardcoded floor by MC release line. Values are conservative — older JDKs
 * still in LTS are preferred over the absolute minimum so users get a
 * runtime with current security fixes.
 */
const MC_VERSION_TO_JAVA_FALLBACK: { prefix: string; major: number }[] = [
  // 1.21+ requires Java 21
  { prefix: "1.21", major: 21 },
  // 1.20.5+ moved to Java 21; 1.20.0–1.20.4 is Java 17. We can't tell the
  // patch level from the prefix alone, so default the whole 1.20 line to
  // 21 — it's a strict superset and the 1.20.4-or-earlier user can pin
  // explicitly via project.json.
  { prefix: "1.20", major: 21 },
  // 1.18, 1.19 → Java 17.
  { prefix: "1.19", major: 17 },
  { prefix: "1.18", major: 17 },
  // 1.17 → Java 16, but 16 isn't an LTS anymore; bump to 17 so install is
  // a no-op for users already on 1.18+.
  { prefix: "1.17", major: 17 },
  // 1.16 and earlier → Java 8 was the floor; Paper actually requires 11+ on
  // 1.16. Pick 11 — it's still in long-term support tooling and runs the
  // class files Mojang ships.
  { prefix: "1.16", major: 11 },
  { prefix: "1.15", major: 8 },
  { prefix: "1.14", major: 8 },
  { prefix: "1.13", major: 8 },
  { prefix: "1.12", major: 8 },
  { prefix: "1.8", major: 8 },
];

/** Default distribution when neither project.json nor flags say otherwise. */
export const DEFAULT_DISTRIBUTION = DEFAULT_DISTRIBUTION_SLUG;

export interface ProjectJdkSelection {
  /** Java major release, e.g. 21. */
  major: number;
  /** Disco distribution slug, e.g. "temurin". */
  distribution: string;
  /** Where the value came from — for diagnostic logging. */
  source: "project-pin" | "spigot-manifest" | "fallback-table" | "fallback-default";
}

/**
 * Resolve which JDK to install for a specific MC version of a project. Pure
 * compute — no FS or network beyond `getJavaRange`'s 5s probe (which silently
 * falls through to the heuristic on failure).
 *
 * `mcVersion` is taken explicitly so matrix-style callers (the test command
 * iterating `compatibility.versions`) can pick the right JDK per cell rather
 * than always using `versions[0]`.
 */
export async function selectJdkForVersion(
  project: ResolvedProject,
  mcVersion: string | undefined,
): Promise<ProjectJdkSelection> {
  const distribution =
    project.jdk?.distribution !== undefined
      ? validateDistribution(project.jdk.distribution)
      : DEFAULT_DISTRIBUTION;

  if (project.jdk?.major !== undefined) {
    return { major: validateJavaMajor(project.jdk.major), distribution, source: "project-pin" };
  }

  if (mcVersion === undefined) {
    return { major: 21, distribution, source: "fallback-default" };
  }

  // Spigot's manifest is keyed by MC version, not by API flavor — it's the
  // canonical answer for any platform targeting that MC version.
  const range = await getJavaRange(mcVersion);
  if (range !== undefined) {
    return { major: range[0], distribution, source: "spigot-manifest" };
  }

  for (const { prefix, major } of MC_VERSION_TO_JAVA_FALLBACK) {
    if (mcVersion === prefix || mcVersion.startsWith(`${prefix}.`)) {
      return { major, distribution, source: "fallback-table" };
    }
  }

  // No prefix match — current latest LTS as the default. Better to over-install
  // than to refuse to build; user can pin if this is wrong.
  return { major: 21, distribution, source: "fallback-default" };
}

/** Resolve the JDK for the project's primary MC version (`versions[0]`). */
export function selectJdkForProject(project: ResolvedProject): Promise<ProjectJdkSelection> {
  return selectJdkForVersion(project, project.compatibility?.versions?.[0]);
}
