/**
 * IntelliJ project scaffolding written once by `pluggy init`.
 *
 * The stub puts the project into IntelliJ's "linked Eclipse" mode, so
 * IntelliJ live-reads `.classpath` for libraries, source folders, and output
 * path on every project load. Without these files, opening the folder in
 * IntelliJ would surface the Eclipse import wizard with the "Link" checkbox
 * defaulting to off, and a user who forgets to tick it gets a one-time
 * snapshot with no live updates.
 *
 * What's written:
 *
 *   <name>.iml         : `classpath="eclipse" classpath-dir="$MODULE_DIR$"`
 *                        the linked-mode flag pair
 *   .idea/modules.xml  : registers `<name>.iml` so IntelliJ skips the wizard
 *   .idea/misc.xml     : `languageLevel` derived from
 *                        `compatibility.versions[0]`; no `project-jdk-name`
 *                        (we can't predict the user's JDK installations, so
 *                        IntelliJ prompts on first open, the same one-time
 *                        setup any new IntelliJ project requires)
 *   .idea/.gitignore   : keeps per-machine state (`workspace.xml`, `shelf/`)
 *                        out of git
 *
 * Pluggy never rewrites these files after `init`. IntelliJ owns its own
 * config from then on, and the `.iml` will accumulate things like the
 * Minecraft Development plugin's facet entries which are none of pluggy's
 * business.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { writeFileLF } from "../portable.ts";
import type { Project } from "../project.ts";

export async function writeIntellijStub(distDir: string, project: Project): Promise<void> {
  const ideaDir = join(distDir, ".idea");
  await mkdir(ideaDir, { recursive: true });

  const major = jdkMajorForMcVersion(project.compatibility?.versions?.[0]);

  await writeFileLF(join(distDir, `${project.name}.iml`), renderIml());
  await writeFileLF(join(ideaDir, "modules.xml"), renderModulesXml(project.name));
  await writeFileLF(join(ideaDir, "misc.xml"), renderMiscXml(major));
  await writeFileLF(join(ideaDir, ".gitignore"), "workspace.xml\nshelf/\nusage.statistics.xml\n");
}

/**
 * Mojang's published Minecraft → JDK requirements:
 *   - 1.21.x → 21
 *   - 1.20.5+ → 21
 *   - 1.18.x – 1.20.4 → 17
 *   - 1.17.x → 16
 *   - ≤ 1.16 → 8
 *
 * Anything we can't parse falls back to 21 (current Paper baseline).
 */
export function jdkMajorForMcVersion(version: string | undefined): number {
  if (version === undefined) return 21;
  const m = version.match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
  if (m === null) return 21;
  const major = Number(m[1]);
  if (major >= 2) return 21;
  const minor = Number(m[2]);
  const patch = m[3] !== undefined ? Number(m[3]) : 0;
  if (minor >= 21) return 21;
  if (minor === 20 && patch >= 5) return 21;
  if (minor >= 18) return 17;
  if (minor === 17) return 16;
  return 8;
}

function renderIml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<module classpath="eclipse" classpath-dir="$MODULE_DIR$" type="JAVA_MODULE" version="4" />
`;
}

function renderModulesXml(name: string): string {
  const imlPath = `$PROJECT_DIR$/${name}.iml`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<project version="4">
  <component name="ProjectModuleManager">
    <modules>
      <module fileurl="file://${escapeXml(imlPath)}" filepath="${escapeXml(imlPath)}" />
    </modules>
  </component>
</project>
`;
}

function renderMiscXml(major: number): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<project version="4">
  <component name="ProjectRootManager" version="2" languageLevel="JDK_${major}" project-jdk-type="JavaSDK">
    <output url="file://$PROJECT_DIR$/.pluggy-build/classes" />
  </component>
</project>
`;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
