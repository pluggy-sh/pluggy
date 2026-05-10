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
const KNOWN_SCHEMES_HINT = 'Known schemes: "modrinth", "maven", "file", "workspace".';

/**
 * Parse the long-form source string that appears in `project.json`
 * dependencies against its declared `version`. Accepts `modrinth:<slug>`,
 * `maven:<groupId>:<artifactId>`, `file:<path>`, and `workspace:<name>`.
 * Throws on malformed input.
 */
export function parseSource(source: string, version: string): ResolvedSource {
  if (typeof source !== "string" || source.length === 0) {
    throw new UserError(`Invalid source: "${source}"; expected a non-empty string`, {
      code: "E_SOURCE_EMPTY",
      hint: KNOWN_SCHEMES_HINT,
    });
  }
  if (source !== source.trim() || /\s/.test(source)) {
    throw new UserError(`Invalid source: "${source}"; must not contain whitespace`, {
      code: "E_SOURCE_WHITESPACE",
      hint: 'Sources are scheme-prefixed like "modrinth:worldedit"; remove any spaces.',
    });
  }

  const colonIndex = source.indexOf(":");
  if (colonIndex === -1) {
    throw new UserError(
      `Invalid source: "${source}"; expected one of "modrinth:", "maven:", "file:", "workspace:"`,
      { code: "E_SOURCE_NO_SCHEME", hint: KNOWN_SCHEMES_HINT },
    );
  }

  const scheme = source.slice(0, colonIndex);
  const rest = source.slice(colonIndex + 1);

  switch (scheme) {
    case "modrinth": {
      if (!SLUG_RE.test(rest)) {
        throw new UserError(
          `Invalid source: "${source}"; expected "modrinth:<slug>" where slug matches /^[a-z0-9][a-z0-9-_]*$/`,
          {
            code: "E_SOURCE_BAD_MODRINTH",
            hint: 'Modrinth slugs are lowercase, e.g. "modrinth:worldedit".',
          },
        );
      }
      return { kind: "modrinth", slug: rest, version };
    }
    case "maven": {
      const parts = rest.split(":");
      if (parts.length !== 2) {
        throw new UserError(
          `Invalid source: "${source}"; expected "maven:<groupId>:<artifactId>"`,
          {
            code: "E_SOURCE_BAD_MAVEN",
            hint: 'Format: "maven:<groupId>:<artifactId>", e.g. "maven:net.kyori:adventure-api".',
          },
        );
      }
      const [groupId, artifactId] = parts;
      if (!MAVEN_COORD_RE.test(groupId) || !MAVEN_COORD_RE.test(artifactId)) {
        throw new UserError(
          `Invalid source: "${source}"; groupId/artifactId must match /^[a-zA-Z][\\w.-]*$/`,
          {
            code: "E_SOURCE_BAD_MAVEN",
            hint: 'groupId/artifactId must start with a letter, e.g. "maven:net.kyori:adventure-api".',
          },
        );
      }
      return { kind: "maven", groupId, artifactId, version };
    }
    case "file": {
      if (rest.length === 0) {
        throw new UserError(
          `Invalid source: "${source}"; expected "file:<path>" with a non-empty path`,
          {
            code: "E_SOURCE_BAD_FILE",
            hint: 'Format: "file:<path>", e.g. "file:./libs/foo.jar".',
          },
        );
      }
      return { kind: "file", path: rest, version };
    }
    case "workspace": {
      if (rest.length === 0) {
        throw new UserError(
          `Invalid source: "${source}"; expected "workspace:<name>" with a non-empty name`,
          {
            code: "E_SOURCE_BAD_WORKSPACE",
            hint: 'Format: "workspace:<name>", e.g. "workspace:my-api".',
          },
        );
      }
      return { kind: "workspace", name: rest, version };
    }
    default: {
      throw new UserError(
        `Invalid source: "${source}"; unknown scheme "${scheme}" (expected "modrinth", "maven", "file", or "workspace")`,
        { code: "E_SOURCE_UNKNOWN_SCHEME", hint: KNOWN_SCHEMES_HINT },
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
    throw new UserError(`Invalid identifier: "${input}"; expected a non-empty string`, {
      code: "E_IDENTIFIER_EMPTY",
      hint: 'Pass an identifier like "worldedit", "worldedit@7.3.15", or "maven:org:lib@1.0".',
    });
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
        {
          code: "E_IDENTIFIER_BAD_MAVEN",
          hint: 'Format: "maven:<groupId>:<artifactId>@<version>", e.g. "maven:net.kyori:adventure-api@4.22.0".',
        },
      );
    }
    const coord = rest.slice(0, atIndex);
    const version = rest.slice(atIndex + 1);
    if (version.length === 0) {
      throw new UserError(`Invalid identifier: "${input}"; version after "@" must not be empty`, {
        code: "E_IDENTIFIER_BAD_MAVEN",
        hint: 'Format: "maven:<groupId>:<artifactId>@<version>".',
      });
    }
    const parts = coord.split(":");
    if (parts.length !== 2) {
      throw new UserError(
        `Invalid identifier: "${input}"; expected "maven:<groupId>:<artifactId>@<version>"`,
        {
          code: "E_IDENTIFIER_BAD_MAVEN",
          hint: 'Format: "maven:<groupId>:<artifactId>@<version>".',
        },
      );
    }
    const [groupId, artifactId] = parts;
    if (!MAVEN_COORD_RE.test(groupId) || !MAVEN_COORD_RE.test(artifactId)) {
      throw new UserError(
        `Invalid identifier: "${input}"; groupId/artifactId must match /^[a-zA-Z][\\w.-]*$/`,
        {
          code: "E_IDENTIFIER_BAD_MAVEN",
          hint: 'groupId/artifactId must start with a letter, e.g. "maven:net.kyori:adventure-api@4.22.0".',
        },
      );
    }
    return { kind: "maven", groupId, artifactId, version };
  }

  if (input.startsWith("workspace:")) {
    const name = input.slice("workspace:".length);
    if (name.length === 0) {
      throw new UserError(
        `Invalid identifier: "${input}"; expected "workspace:<name>" with a non-empty name`,
        {
          code: "E_IDENTIFIER_BAD_WORKSPACE",
          hint: 'Format: "workspace:<name>", e.g. "workspace:my-api".',
        },
      );
    }
    if (name.includes("@")) {
      throw new UserError(
        `Invalid identifier: "${input}"; workspace identifiers do not accept a version`,
        {
          code: "E_IDENTIFIER_BAD_WORKSPACE",
          hint: "Workspace identifiers track the workspace's own version; drop the @<version>.",
        },
      );
    }
    return { kind: "workspace", name, version: LATEST_STABLE };
  }

  // Modrinth `<slug>[@<version>]`: reject multi-`@` to keep the grammar unambiguous.
  const atIndex = input.indexOf("@");
  if (atIndex !== -1 && input.indexOf("@", atIndex + 1) !== -1) {
    throw new UserError(
      `Invalid identifier: "${input}"; multiple "@" separators; expected "<slug>[@<version>]"`,
      {
        code: "E_IDENTIFIER_BAD_MODRINTH",
        hint: 'Format: "<slug>[@<version>]", e.g. "worldedit@7.3.15".',
      },
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
      throw new UserError(`Invalid identifier: "${input}"; version after "@" must not be empty`, {
        code: "E_IDENTIFIER_BAD_MODRINTH",
        hint: 'Format: "<slug>[@<version>]", e.g. "worldedit@7.3.15".',
      });
    }
  }
  if (!SLUG_RE.test(slug)) {
    throw new UserError(`Invalid identifier: "${input}"; slug must match /^[a-z0-9][a-z0-9-_]*$/`, {
      code: "E_IDENTIFIER_BAD_MODRINTH",
      hint: 'Modrinth slugs are lowercase, e.g. "worldedit".',
    });
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
