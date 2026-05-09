/**
 * `${project.x}` substitution used by `init` and the build pipeline to seed
 * template files with values from `project.json`.
 *
 * Escape hatch: prefix a placeholder with a backslash to keep it literal.
 * `\${anything}` emits as `${anything}`, with the leading backslash stripped.
 * Useful for YAML / JSON files that legitimately contain `${...}` syntax
 * (for example, plugin configs that reference their own placeholders at runtime).
 */

/**
 * Flatten a nested object into a dotted-path map of scalar strings:
 * `{ a: { b: 1 } }` yields `{ "a.b": "1" }`. Arrays yield numeric-suffixed
 * keys (`list.0`, `list.1`, ...).
 */
export function generateReplacementMap(
  obj: Record<string, unknown>,
  prefix = "",
): Map<string, string> {
  const map = new Map<string, string>();

  for (const [key, value] of Object.entries(obj)) {
    const newKey = prefix ? `${prefix}.${key}` : key;

    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const nestedMap = generateReplacementMap(value as Record<string, unknown>, newKey);
      nestedMap.forEach((val, nestedKey) => map.set(nestedKey, val));
    } else if (Array.isArray(value)) {
      value.forEach((item, index) => {
        map.set(`${newKey}.${index}`, String(item));
      });
    } else {
      map.set(newKey, String(value));
    }
  }

  return map;
}

/**
 * Substitute every `${dotted.key}` in `template` with the matching value
 * from `obj`. Occurrences preceded by a backslash (`\${...}`) are treated
 * as literal: the backslash is stripped and the placeholder is emitted
 * unchanged. Unknown keys are left as-is.
 */
export function replace(template: string, obj: Record<string, unknown>): string {
  const replacementMap = generateReplacementMap(obj);
  let result = template;

  for (const [key, value] of replacementMap.entries()) {
    // Negative lookbehind skips backslash-escaped occurrences.
    const regex = new RegExp(`(?<!\\\\)\\$\\{${escapeRegExp(key)}\\}`, "g");
    result = result.replace(regex, value);
  }

  // Strip the escape backslash so `\${foo}` emits `${foo}` literally.
  result = result.replace(/\\(\$\{[^}]*\})/g, "$1");

  return result;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
