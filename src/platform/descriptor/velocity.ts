import type { DescriptorSpec } from "../platform.ts";

/** Velocity descriptor → `velocity-plugin.json`. */
export const velocityDescriptor: DescriptorSpec = {
  path: "velocity-plugin.json",
  format: "json",
  family: "velocity",
  generate(project) {
    if (!project.main) {
      throw new Error("Velocity descriptor requires project.main");
    }

    const descriptor: Record<string, unknown> = {
      id: deriveVelocityId(project.name),
      name: project.name,
      version: project.version,
      main: project.main,
    };

    if (project.description && project.description.length > 0) {
      descriptor.description = project.description;
    }

    if (project.authors && project.authors.length > 0) {
      descriptor.authors = project.authors;
    }

    return `${JSON.stringify(descriptor, null, 2)}\n`;
  },
};

/**
 * Derive a Velocity plugin `id` from `project.name`. Velocity ids must match
 * `[a-z][a-z0-9-_]*`, so we lowercase, substitute any out-of-range character
 * with `-`, and prefix `p-` if the result doesn't start with a letter.
 */
export function deriveVelocityId(name: string): string {
  const lowered = name.toLowerCase();
  const normalized = lowered.replace(/[^a-z0-9_-]/g, "-");
  if (!/^[a-z]/.test(normalized)) {
    return `p-${normalized}`;
  }
  return normalized;
}
