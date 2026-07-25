/**
 * IDE integration. Emits the Java common baseline (`.classpath` + `.project`)
 * on every build. That's the entire surface.
 *
 * Every supported IDE consumes those files directly:
 *   - Eclipse:   native, live
 *   - VS Code:   via the Red Hat Java extension, live
 *   - IntelliJ:  via "Import Eclipse project" with "Link created IntelliJ
 *                IDEA module to existing Eclipse project files" ticked, live
 *
 * Pluggy never touches `.vscode/` or `.idea/`. The classpath is the single
 * source of truth, regenerated on every build.
 */

import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";

import { writeFileLF } from "../portable.ts";
import type { ResolvedProject } from "../project.ts";

/**
 * Write `.classpath` and `.project` at the project root. Throws on real
 * failures; the caller wraps in try/catch and logs at debug, so IDE
 * scaffolding never blocks a build.
 */
export async function writeIdeFiles(
  project: ResolvedProject,
  classpath: string[],
  stagingOutputDir: string,
): Promise<void> {
  const out = relative(project.rootDir, stagingOutputDir) || ".pluggy-build";
  await writeIfChanged(join(project.rootDir, ".classpath"), renderEclipseClasspath(classpath, out));
  await writeIfChanged(join(project.rootDir, ".project"), renderEclipseProject(project.name));
}

/**
 * Skip the write when the content already matches. Rewriting these on every
 * build churned file mtimes for no reason, which is what `--skip-classpath`
 * existed to avoid; making it automatic retired the flag.
 */
async function writeIfChanged(path: string, content: string): Promise<void> {
  try {
    if ((await readFile(path, "utf8")) === content) return;
  } catch {
    // Missing or unreadable: fall through and write it.
  }
  await writeFileLF(path, content);
}

function renderEclipseClasspath(classpath: string[], outputPath: string): string {
  const entries = [
    `  <classpathentry kind="src" path="src"/>`,
    `  <classpathentry kind="con" path="org.eclipse.jdt.launching.JRE_CONTAINER"/>`,
    ...classpath.map((jar) => `  <classpathentry kind="lib" path="${escapeXml(jar)}"/>`),
    `  <classpathentry kind="output" path="${escapeXml(outputPath)}"/>`,
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<classpath>
${entries.join("\n")}
</classpath>
`;
}

function renderEclipseProject(name: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<projectDescription>
  <name>${escapeXml(name)}</name>
  <comment></comment>
  <projects></projects>
  <buildSpec>
    <buildCommand>
      <name>org.eclipse.jdt.core.javabuilder</name>
      <arguments></arguments>
    </buildCommand>
  </buildSpec>
  <natures>
    <nature>org.eclipse.jdt.core.javanature</nature>
  </natures>
</projectDescription>
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
