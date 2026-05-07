import type { DescriptorSpec } from "../platform.ts";

/**
 * Sponge plugin metadata descriptor → `META-INF/sponge_plugins.json`.
 *
 * Targets the modern SpongeAPI 8+ Plugin Metadata format with the built-in
 * `java_plain` loader: one entry under `plugins[]`, `entrypoint` set to the
 * fully-qualified main class. Annotation-driven discovery isn't required
 * with `java_plain`, so the user can ship without the Sponge AP on their
 * compile classpath.
 *
 * See: https://docs.spongepowered.org/stable/en/plugin/plugin-meta.html
 */
export const spongeDescriptor: DescriptorSpec = {
  path: "META-INF/sponge_plugins.json",
  format: "json",
  family: "sponge",
  generate(project) {
    if (!project.main) {
      throw new Error("Sponge descriptor requires project.main");
    }

    const plugin: Record<string, unknown> = {
      id: deriveSpongeId(project.name),
      name: project.name,
      entrypoint: project.main,
    };

    if (project.description && project.description.length > 0) {
      plugin.description = project.description;
    }

    if (project.authors && project.authors.length > 0) {
      plugin.contributors = project.authors.map((name) => ({ name }));
    }

    const descriptor = {
      loader: { name: "java_plain", version: "1.0" },
      license: "All Rights Reserved",
      global: { version: project.version },
      plugins: [plugin],
    };

    return `${JSON.stringify(descriptor, null, 2)}\n`;
  },
};

/**
 * Derive a Sponge plugin `id` from `project.name`. Sponge ids must match
 * `^[a-z][a-z0-9-_]{1,63}$` (start with a letter, 2 – 64 chars). We
 * lowercase, substitute disallowed characters with `-`, prefix `p-` if the
 * result doesn't start with a letter, and truncate to 64 chars.
 */
export function deriveSpongeId(name: string): string {
  const lowered = name.toLowerCase();
  let normalized = lowered.replace(/[^a-z0-9_-]/g, "-");
  if (!/^[a-z]/.test(normalized)) {
    normalized = `p-${normalized}`;
  }
  if (normalized.length < 2) {
    normalized = `${normalized}-plugin`;
  }
  return normalized.slice(0, 64);
}
