/**
 * Docs pipeline — resolve classpath → discover sources → run javadoc.
 * Workspace orchestration is the caller's job; `generateDocs` handles
 * exactly one workspace per call.
 */

import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";

import { resolveProjectClasspath } from "../build/classpath.ts";
import { findJavaSources } from "../build/compile.ts";
import { log } from "../logging.ts";
import type { ResolvedProject } from "../project.ts";
import { ensureJdkForProject } from "../sdk/index.ts";

import { runJavadoc } from "./javadoc.ts";

export interface DocsOptions {
  /** Output directory. Default: `<rootDir>/docs/<name>-<version>/`. */
  output?: string;
  /** Wipe `output` before running so deleted classes don't leave stale HTML. */
  clean?: boolean;
  /** Visibility passed to javadoc. Default `"protected"` matches javadoc's own default. */
  access?: "public" | "protected" | "package" | "private";
  /** Extra `-link <url>` entries added after the platform/built-in defaults. */
  links?: string[];
}

export interface DocsResult {
  /** Absolute output directory containing `index.html`. */
  outputPath: string;
  /** Number of files written under `outputPath` (HTML + assets). */
  fileCount: number;
  /** Total bytes written under `outputPath`. */
  sizeBytes: number;
  /** Warning lines emitted by javadoc — not fatal, but worth surfacing. */
  warnings: number;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
}

/**
 * Generate javadoc for one project. Throws on resolver, JDK, or javadoc
 * failure — partial output is left in `outputPath` for inspection.
 *
 * Output layout: `<rootDir>/docs/<name>-<version>/index.html`. The directory
 * is keyed by version so two side-by-side runs for the same project at
 * different versions don't clobber each other.
 */
export async function generateDocs(
  project: ResolvedProject,
  opts: DocsOptions = {},
): Promise<DocsResult> {
  const started = Date.now();

  const outputPath =
    opts.output ?? join(project.rootDir, "docs", `${project.name}-${project.version}`);

  if (opts.clean === true) {
    await rm(outputPath, { recursive: true, force: true });
  }
  await mkdir(dirname(outputPath), { recursive: true });

  const sourceDir = join(project.rootDir, "src");
  const [{ classpath }, jdk, sources] = await Promise.all([
    resolveProjectClasspath(project),
    ensureJdkForProject(project),
    findJavaSources(sourceDir),
  ]);

  if (sources.length === 0) {
    throw new Error(
      `docs: no .java sources found under "${sourceDir}" for project "${project.name}"`,
    );
  }

  const javadocPath = resolveJavadocBinary(jdk.javacPath);
  const access = opts.access ?? "protected";
  const titleSuffix = project.description ?? "";
  const docTitle =
    titleSuffix.length > 0
      ? `${project.name} ${project.version} — ${titleSuffix}`
      : `${project.name} ${project.version}`;

  const { warnings } = await runJavadoc(project, {
    sources,
    outputDir: outputPath,
    sourcePaths: [sourceDir],
    classpath,
    access,
    release: jdk.major,
    quiet: !isVerbose(),
    windowTitle: `${project.name} ${project.version}`,
    docTitle,
    links: opts.links ?? [],
    javadocPath,
  });

  const { fileCount, sizeBytes } = await measureTree(outputPath);

  log.debug(`docs: wrote ${fileCount} files (${sizeBytes} bytes) to ${outputPath}`);

  return {
    outputPath,
    fileCount,
    sizeBytes,
    warnings,
    durationMs: Date.now() - started,
  };
}

/**
 * Mirror logging.ts's verbosity test. javadoc emits a line per source file
 * even on success, so default behavior is `-quiet` and we only let the
 * chatter through when the user has opted in to verbose logging.
 */
function isVerbose(): boolean {
  return (
    process.argv.includes("-v") ||
    process.argv.includes("--verbose") ||
    process.env.DEBUG !== undefined
  );
}

/**
 * Derive the `javadoc` binary path from the resolved JDK's `javacPath`.
 * The SDK module exposes `javacPath` (the only Java tool the build needs);
 * `javadoc` lives in the same `bin/` directory under the same suffix
 * convention (`.exe` on Windows, no suffix elsewhere).
 */
function resolveJavadocBinary(javacPath: string): string {
  if (javacPath.endsWith("javac.exe")) {
    return `${javacPath.slice(0, -"javac.exe".length)}javadoc.exe`;
  }
  if (javacPath.endsWith("javac")) {
    return `${javacPath.slice(0, -"javac".length)}javadoc`;
  }
  // Fallback: PATH lookup. Lets users with custom PATH layouts still work,
  // and makes test-time shimming via `"javac"` literal trivial.
  return "javadoc";
}

async function measureTree(root: string): Promise<{ fileCount: number; sizeBytes: number }> {
  let fileCount = 0;
  let sizeBytes = 0;

  async function walk(current: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        fileCount++;
        try {
          const info = await stat(full);
          sizeBytes += info.size;
        } catch {
          // File vanished between readdir and stat — ignore.
        }
      }
    }
  }

  await walk(root);
  return { fileCount, sizeBytes };
}
