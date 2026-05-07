/**
 * The curated allowlist of JDK distributions pluggy auto-installs. GraalVM CE
 * is included for plugins that use Polyglot/Truffle scripting (Oracle's paid
 * `graalvm` is excluded — auto-installing it would require user license
 * consent we can't model here). Expanding this list is safe; narrowing it
 * isn't, so be conservative when adding.
 *
 * The allowlist must apply to every source of a distribution slug — CLI
 * flags, project.json, and any other config — because the slug ends up in a
 * filesystem path under the user cache.
 */

import { InvalidArgumentError } from "commander";

export const ALLOWED_DISTRIBUTIONS = [
  "temurin",
  "zulu",
  "liberica",
  "corretto",
  "microsoft",
  "graalvm_community",
] as const;

export type AllowedDistribution = (typeof ALLOWED_DISTRIBUTIONS)[number];

export const DEFAULT_DISTRIBUTION: AllowedDistribution = "temurin";

/** Java major releases pluggy will provision. Mirrors `parseMajor` in `commands/sdk.ts`. */
export const MIN_JAVA_MAJOR = 6;
export const MAX_JAVA_MAJOR = 99;

/** Commander option parser — throws InvalidArgumentError on miss. */
export function parseDistribution(value: string): AllowedDistribution {
  if (!ALLOWED_DISTRIBUTIONS.includes(value as AllowedDistribution)) {
    throw new InvalidArgumentError(
      `unknown distribution "${value}". Allowed: ${ALLOWED_DISTRIBUTIONS.join(", ")}`,
    );
  }
  return value as AllowedDistribution;
}

/**
 * Validate a distribution slug coming from project.json (or any other config
 * file). Throws a regular Error so the top-level CLI handler treats it as a
 * config problem, not a CLI usage error.
 */
export function validateDistribution(value: unknown): AllowedDistribution {
  if (typeof value !== "string") {
    throw new Error(
      `project.jdk.distribution must be a string. Allowed: ${ALLOWED_DISTRIBUTIONS.join(", ")}`,
    );
  }
  if (!ALLOWED_DISTRIBUTIONS.includes(value as AllowedDistribution)) {
    throw new Error(
      `project.jdk.distribution: unknown distribution "${value}". Allowed: ${ALLOWED_DISTRIBUTIONS.join(", ")}`,
    );
  }
  return value as AllowedDistribution;
}

/**
 * Validate a Java major release coming from project.json. Throws on values
 * that aren't a positive integer in `[MIN_JAVA_MAJOR, MAX_JAVA_MAJOR]`.
 */
export function validateJavaMajor(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`project.jdk.major must be an integer (got ${JSON.stringify(value)})`);
  }
  if (value < MIN_JAVA_MAJOR || value > MAX_JAVA_MAJOR) {
    throw new Error(
      `project.jdk.major must be between ${MIN_JAVA_MAJOR} and ${MAX_JAVA_MAJOR} (got ${value})`,
    );
  }
  return value;
}
