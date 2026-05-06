import type { DescriptorSpec } from "../platform.ts";

/** Bukkit-family descriptor (paper, folia, spigot, bukkit) → `plugin.yml`. */
export const bukkitDescriptor: DescriptorSpec = {
  path: "plugin.yml",
  format: "yaml",
  family: "bukkit",
  generate(project) {
    if (!project.main) {
      throw new Error("Bukkit descriptor requires project.main");
    }

    const lines: string[] = [];
    lines.push(`name: ${yamlScalar(project.name)}`);
    lines.push(`version: ${yamlScalar(project.version)}`);
    lines.push(`main: ${yamlScalar(project.main)}`);

    if (project.description && project.description.length > 0) {
      lines.push(`description: ${yamlScalar(project.description)}`);
    }

    const apiVersion = deriveApiVersion(project.compatibility?.versions?.[0]);
    if (apiVersion) {
      lines.push(`api-version: ${yamlScalar(apiVersion)}`);
    }

    if (project.authors && project.authors.length > 0) {
      lines.push("authors:");
      for (const author of project.authors) {
        lines.push(`  - ${yamlScalar(author)}`);
      }
    }

    return `${lines.join("\n")}\n`;
  },
};

/**
 * Derive a Bukkit `api-version` (major.minor) from a full MC version:
 * "1.21.8" → "1.21". Returns `undefined` when the input is missing or
 * lacks two numeric dot-segments.
 */
function deriveApiVersion(primaryVersion: string | undefined): string | undefined {
  if (!primaryVersion) return undefined;
  const parts = primaryVersion.split(".");
  if (parts.length < 2) return undefined;
  const [major, minor] = parts;
  if (!/^\d+$/.test(major) || !/^\d+$/.test(minor)) return undefined;
  return `${major}.${minor}`;
}

/**
 * Emit a YAML scalar, double-quoting when the value would otherwise be
 * parsed as a bool/null/number or contains block-structure characters.
 */
function yamlScalar(value: string): string {
  if (value.length === 0) return '""';

  const needsQuoteChars = /[:#"'\\\t\n\r]/.test(value);

  const firstChar = value[0];
  const reservedFirst = "!&*?|>%@`-[]{},";
  const startsWithSpace = firstChar === " ";
  const endsWithSpace = value[value.length - 1] === " ";
  const startsWithReserved = reservedFirst.includes(firstChar);

  const lowered = value.toLowerCase();
  const reservedWord =
    lowered === "true" ||
    lowered === "false" ||
    lowered === "yes" ||
    lowered === "no" ||
    lowered === "on" ||
    lowered === "off" ||
    lowered === "null" ||
    lowered === "~" ||
    lowered === "";
  const looksNumeric = /^-?\d+(\.\d+)?$/.test(value);

  if (
    !needsQuoteChars &&
    !startsWithReserved &&
    !startsWithSpace &&
    !endsWithSpace &&
    !reservedWord &&
    !looksNumeric
  ) {
    return value;
  }

  let escaped = "";
  for (const ch of value) {
    if (ch === "\\") escaped += "\\\\";
    else if (ch === '"') escaped += '\\"';
    else if (ch === "\n") escaped += "\\n";
    else if (ch === "\r") escaped += "\\r";
    else if (ch === "\t") escaped += "\\t";
    else escaped += ch;
  }
  return `"${escaped}"`;
}
