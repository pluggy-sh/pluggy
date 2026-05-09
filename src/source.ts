/**
 * Source-string parser for `project.json` dependency sources and CLI
 * install-identifier forms.
 */

import { UserError } from "./errors.ts";

/** Tagged union of every dependency source kind the resolver understands. */
export type ResolvedSource =
  | { kind: "modrinth"; slug: string; version: string }
  | { kind: "maven"; groupId: string; artifactId: string; version: string }
  | { kind: "file"; path: string; version: string }
  | { kind: "workspace"; name: string; version: string };

const SLUG_RE = /^[a-z0-9][a-z0-9\-_]*$/;
const MAVEN_COORD_RE = /^[a-zA-Z][\w.-]*$/;
const LATEST_STABLE = "*";

/**
 * Parse the long-form source string that appears in `project.json`
 * dependencies against its declared `version`. Accepts `modrinth:<slug>`,
 * `maven:<groupId>:<artifactId>`, `file:<path>`, and `workspace:<name>`.
 * Throws on malformed input.
 */
export function parseSource(source: string, version: string): ResolvedSource {
  if (typeof source !== "string" || source.length === 0) {
    throw new UserError(`Invalid source: "${source}"; expected a non-empty string`);
  }
  if (source !== source.trim() || /\s/.test(source)) {
    throw new UserError(`Invalid source: "${source}"; must not contain whitespace`);
  }

  const colonIndex = source.indexOf(":");
  if (colonIndex === -1) {
    throw new UserError(
      `Invalid source: "${source}"; expected one of "modrinth:", "maven:", "file:", "workspace:"`,
    );
  }

  const scheme = source.slice(0, colonIndex);
  const rest = source.slice(colonIndex + 1);

  switch (scheme) {
    case "modrinth": {
      if (!SLUG_RE.test(rest)) {
        throw new UserError(
          `Invalid source: "${source}"; expected "modrinth:<slug>" where slug matches /^[a-z0-9][a-z0-9-_]*$/`,
        );
      }
      return { kind: "modrinth", slug: rest, version };
    }
    case "maven": {
      const parts = rest.split(":");
      if (parts.length !== 2) {
        throw new UserError(`Invalid source: "${source}"; expected "maven:<groupId>:<artifactId>"`);
      }
      const [groupId, artifactId] = parts;
      if (!MAVEN_COORD_RE.test(groupId) || !MAVEN_COORD_RE.test(artifactId)) {
        throw new UserError(
          `Invalid source: "${source}"; groupId/artifactId must match /^[a-zA-Z][\\w.-]*$/`,
        );
      }
      return { kind: "maven", groupId, artifactId, version };
    }
    case "file": {
      if (rest.length === 0) {
        throw new UserError(
          `Invalid source: "${source}"; expected "file:<path>" with a non-empty path`,
        );
      }
      return { kind: "file", path: rest, version };
    }
    case "workspace": {
      if (rest.length === 0) {
        throw new UserError(
          `Invalid source: "${source}"; expected "workspace:<name>" with a non-empty name`,
        );
      }
      return { kind: "workspace", name: rest, version };
    }
    default: {
      throw new UserError(
        `Invalid source: "${source}"; unknown scheme "${scheme}" (expected "modrinth", "maven", "file", or "workspace")`,
      );
    }
  }
}

/**
 * Parse a CLI install identifier. Accepts `<slug>[@<version>]` (Modrinth),
 * `<path>.jar` (local file), `maven:<groupId>:<artifactId>@<version>`, and
 * `workspace:<name>`. Absent Modrinth/Maven versions resolve to `"*"` (latest
 * stable); the resolver concretizes. Throws on malformed input.
 */
export function parseIdentifier(input: string): ResolvedSource {
  if (typeof input !== "string" || input.length === 0) {
    throw new UserError(`Invalid identifier: "${input}"; expected a non-empty string`);
  }

  if (/\.jar$/i.test(input)) {
    return { kind: "file", path: input, version: LATEST_STABLE };
  }

  if (input.startsWith("maven:")) {
    const rest = input.slice("maven:".length);
    const atIndex = rest.lastIndexOf("@");
    if (atIndex === -1) {
      throw new UserError(
        `Invalid identifier: "${input}"; expected "maven:<groupId>:<artifactId>@<version>"`,
      );
    }
    const coord = rest.slice(0, atIndex);
    const version = rest.slice(atIndex + 1);
    if (version.length === 0) {
      throw new UserError(`Invalid identifier: "${input}"; version after "@" must not be empty`);
    }
    const parts = coord.split(":");
    if (parts.length !== 2) {
      throw new UserError(
        `Invalid identifier: "${input}"; expected "maven:<groupId>:<artifactId>@<version>"`,
      );
    }
    const [groupId, artifactId] = parts;
    if (!MAVEN_COORD_RE.test(groupId) || !MAVEN_COORD_RE.test(artifactId)) {
      throw new UserError(
        `Invalid identifier: "${input}"; groupId/artifactId must match /^[a-zA-Z][\\w.-]*$/`,
      );
    }
    return { kind: "maven", groupId, artifactId, version };
  }

  if (input.startsWith("workspace:")) {
    const name = input.slice("workspace:".length);
    if (name.length === 0) {
      throw new UserError(
        `Invalid identifier: "${input}"; expected "workspace:<name>" with a non-empty name`,
      );
    }
    if (name.includes("@")) {
      throw new UserError(
        `Invalid identifier: "${input}"; workspace identifiers do not accept a version`,
      );
    }
    return { kind: "workspace", name, version: LATEST_STABLE };
  }

  // Modrinth `<slug>[@<version>]`: reject multi-`@` to keep the grammar unambiguous.
  const atIndex = input.indexOf("@");
  if (atIndex !== -1 && input.indexOf("@", atIndex + 1) !== -1) {
    throw new UserError(
      `Invalid identifier: "${input}"; multiple "@" separators; expected "<slug>[@<version>]"`,
    );
  }
  let slug: string;
  let version: string;
  if (atIndex === -1) {
    slug = input;
    version = LATEST_STABLE;
  } else {
    slug = input.slice(0, atIndex);
    version = input.slice(atIndex + 1);
    if (version.length === 0) {
      throw new UserError(`Invalid identifier: "${input}"; version after "@" must not be empty`);
    }
  }
  if (!SLUG_RE.test(slug)) {
    throw new UserError(`Invalid identifier: "${input}"; slug must match /^[a-z0-9][a-z0-9-_]*$/`);
  }
  return { kind: "modrinth", slug, version };
}

/**
 * Serialize a `ResolvedSource` back into the `project.json` source-string
 * form. The version component is excluded; it lives in its own field.
 */
export function stringifySource(source: ResolvedSource): string {
  switch (source.kind) {
    case "modrinth":
      return `modrinth:${source.slug}`;
    case "maven":
      return `maven:${source.groupId}:${source.artifactId}`;
    case "file":
      return `file:${source.path}`;
    case "workspace":
      return `workspace:${source.name}`;
  }
}
