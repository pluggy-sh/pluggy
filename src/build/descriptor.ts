import { platforms } from "../platform/index.ts";
import type { DescriptorSpec } from "../platform/platform.ts";
import type { ResolvedProject } from "../project.ts";

/**
 * Pick the descriptor spec for the project's primary platform and verify
 * that all declared platforms share the same descriptor family.
 *
 * A family is keyed by `descriptor.path`. Cross-family `compatibility.platforms`
 * arrays throw with guidance to split into separate workspaces.
 */
export function pickDescriptor(project: ResolvedProject): DescriptorSpec {
  const declaredPlatforms = project.compatibility?.platforms;
  if (!Array.isArray(declaredPlatforms) || declaredPlatforms.length === 0) {
    throw new Error(
      `build: project "${project.name}" has no compatibility.platforms declared; at least one platform is required`,
    );
  }

  const primaryId = declaredPlatforms[0];
  let primary;
  try {
    primary = platforms.get(primaryId);
  } catch {
    throw new Error(
      `build: project "${project.name}" declares unknown primary platform "${primaryId}"`,
    );
  }

  for (let i = 1; i < declaredPlatforms.length; i++) {
    const id = declaredPlatforms[i];
    let other;
    try {
      other = platforms.get(id);
    } catch {
      throw new Error(
        `build: project "${project.name}" declares unknown platform "${id}" in compatibility.platforms`,
      );
    }
    if (other.descriptor.path !== primary.descriptor.path) {
      throw new Error(
        `build: project "${project.name}" declares platforms from different descriptor families ` +
          `("${primaryId}" uses "${primary.descriptor.path}", "${id}" uses "${other.descriptor.path}"). ` +
          `Split them into separate workspaces, one per family.`,
      );
    }
  }

  return primary.descriptor;
}
