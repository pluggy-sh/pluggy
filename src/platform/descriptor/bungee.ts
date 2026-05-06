import type { DescriptorSpec } from "../platform.ts";

/**
 * BungeeCord-family descriptor (waterfall, travertine) → `bungee.yml`.
 * Uses a singular `author` field; multiple authors are joined with ", ".
 */
export const bungeeDescriptor: DescriptorSpec = {
  path: "bungee.yml",
  format: "yaml",
  family: "bungee",
  generate(project) {
    if (!project.main) {
      throw new Error("BungeeCord descriptor requires project.main");
    }

    const lines: string[] = [];
    lines.push(`name: ${yamlScalar(project.name)}`);
    lines.push(`version: ${yamlScalar(project.version)}`);
    lines.push(`main: ${yamlScalar(project.main)}`);

    if (project.description && project.description.length > 0) {
      lines.push(`description: ${yamlScalar(project.description)}`);
    }

    if (project.authors && project.authors.length > 0) {
      lines.push(`author: ${yamlScalar(project.authors.join(", "))}`);
    }

    return `${lines.join("\n")}\n`;
  },
};

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
    lowered === "~";
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
