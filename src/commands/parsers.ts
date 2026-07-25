/**
 * commander argParser functions. Each validates, throws `InvalidArgumentError`
 * on failure, and returns the parsed value. Commander interpolates the
 * return value into the parsed option.
 */

import process from "node:process";

import { InvalidArgumentError, Option } from "commander";

import { platforms } from "../platform/index.ts";
import { parseIdentifier } from "../source.ts";

/**
 * Validate a plugin identifier and return the raw string. Downstream code
 * calls `parseIdentifier` again for the tagged union; this parser exists so
 * commander surfaces malformed identifiers at parse time.
 */
export function parseIdentifierArg(value: string): string {
  try {
    parseIdentifier(value);
  } catch (err) {
    throw new InvalidArgumentError((err as Error).message);
  }
  return value;
}

export function parseSemver(value: string): string {
  if (/^\d+\.\d+\.\d+(-[a-zA-Z0-9]+)?$/.test(value)) return value;
  throw new InvalidArgumentError(
    `Invalid semver version: ${value} - expected format like 1.0.0 or 1.0.0-alpha`,
  );
}

export function parsePlatform(value: string): string {
  const resolved = platforms.resolve(value);
  if (resolved !== undefined) return resolved;
  const registered = platforms.list();
  throw new InvalidArgumentError(
    `Invalid platform: "${value}". Available platforms: ${registered.join(", ")}`,
  );
}

export function parseMcVersion(value: string): string {
  if (/^\d+\.\d+(\.\d+)?(-[a-zA-Z0-9.]+)?$/.test(value)) return value;
  throw new InvalidArgumentError(
    `Invalid Minecraft version: ${value}; expected format like 1.21.8 or 26.1.2`,
  );
}

/**
 * Repeatable + comma-separated platform list, validated per element.
 *
 * `--platform` had four grammars across the CLI, two of which validated
 * nothing — so an unknown platform reached `project.json` and only surfaced
 * much later as a build failure.
 */
export function platformListOption(value: string, prev: string[] | undefined): string[] {
  return dedupe(prev, splitList(value).map(parsePlatform));
}

/** Repeatable + comma-separated Minecraft versions, shape-checked per element. */
export function mcVersionListOption(value: string, prev: string[] | undefined): string[] {
  return dedupe(prev, splitList(value).map(parseMcVersion));
}

const FQCN_RE = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)+$/;

export function parseMainClass(value: string): string {
  if (FQCN_RE.test(value)) return value;
  throw new InvalidArgumentError(
    `Invalid main class: "${value}". Use a fully qualified class name, e.g. com.example.Main.`,
  );
}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function dedupe(prev: string[] | undefined, next: string[]): string[] {
  const out = [...(prev ?? [])];
  for (const item of next) if (!out.includes(item)) out.push(item);
  return out;
}

export function parseInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) throw new InvalidArgumentError(`Invalid integer: ${value}`);
  return parsed;
}

/**
 * Shared `--concurrency` option.
 *
 * Four commands each declared their own copy with a separate inline validator
 * and a subtly different description, one of which contradicted its own
 * docblock. Concurrency is also a property of the machine rather than of a
 * single invocation, so `PLUGGY_CONCURRENCY` supplies the default — matching
 * the existing `PLUGGY_NO_AUTO_INSTALL` / `PLUGGY_NO_UPDATE_CHECK` pattern.
 */
export function concurrencyOption(): Option {
  const option = new Option(
    "--concurrency <n>",
    "Cap on workspaces running simultaneously. Use 1 for serial output.",
  ).argParser((raw: string) => {
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n < 1) {
      throw new InvalidArgumentError("--concurrency must be a positive integer");
    }
    return n;
  });
  const fromEnv = Number.parseInt(process.env.PLUGGY_CONCURRENCY ?? "", 10);
  return Number.isFinite(fromEnv) && fromEnv >= 1 ? option.default(fromEnv) : option;
}

/**
 * JVM heap size, as `-Xmx` accepts it. Unvalidated, this went straight into
 * the spawn arguments, so a typo surfaced as a JVM startup crash rather than
 * a CLI error.
 */
export function parseMemory(value: string): string {
  if (/^\d+[kmgKMG]?$/.test(value)) return value;
  throw new InvalidArgumentError(
    `Invalid heap size: "${value}". Use a number with an optional K, M, or G suffix, e.g. 2G or 512M.`,
  );
}
