/**
 * javadoc driver. Same shape as `compileJava`: never invokes a shell, joins
 * the classpath with the platform delimiter, and tails stderr on failure so
 * CI output stays readable.
 */

import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { delimiter } from "node:path";

import { log } from "../logging.ts";
import type { ResolvedProject } from "../project.ts";

export interface JavadocOptions {
  /** Files to document. Must be non-empty; orchestrator passes `findJavaSources` output. */
  sources: string[];
  /** Output directory. Created (recursively) before invocation. */
  outputDir: string;
  /** Source path roots passed via `-sourcepath` (joined with the platform delimiter). */
  sourcePaths: string[];
  /** Compile classpath used for symbol resolution. */
  classpath: string[];
  /** Javadoc visibility, passed as `-public` / `-protected` / `-package` / `-private`. */
  access: "public" | "protected" | "package" | "private";
  /** Java release the docs are compiled against (matches `--release` in javac). */
  release: number;
  /** Whether to suppress non-error javadoc chatter (`-quiet`). */
  quiet: boolean;
  /** `-windowtitle` value (browser tab title). */
  windowTitle: string;
  /** `-doctitle` value (HTML index page title). */
  docTitle: string;
  /** External javadocs to cross-link via `-link <url>`. */
  links: string[];
  /**
   * Absolute `javadoc` path. Defaults to `"javadoc"` (PATH lookup); the
   * orchestrator overrides with the SDK-resolved JDK so the same JDK serves
   * the whole pipeline.
   */
  javadocPath?: string;
}

export interface JavadocResult {
  /** Number of `warning:` lines emitted by javadoc (best-effort count). */
  warnings: number;
}

const MAX_STDERR_LINES = 40;

/**
 * Run `javadoc` against `opts.sources`. Throws on a non-zero exit, attaching
 * the last 40 lines of stderr to the message; matches `compileJava`'s
 * failure shape so the CLI can render either uniformly.
 */
export async function runJavadoc(
  project: ResolvedProject,
  opts: JavadocOptions,
): Promise<JavadocResult> {
  if (opts.sources.length === 0) {
    throw new Error(`No .java sources to document for project "${project.name}"`);
  }

  await mkdir(opts.outputDir, { recursive: true });

  const args: string[] = [
    "-d",
    opts.outputDir,
    "-encoding",
    "UTF-8",
    "-docencoding",
    "UTF-8",
    "-charset",
    "UTF-8",
    `-${opts.access}`,
    "--release",
    String(opts.release),
    "-windowtitle",
    opts.windowTitle,
    "-doctitle",
    opts.docTitle,
  ];

  if (opts.quiet) args.push("-quiet");

  if (opts.sourcePaths.length > 0) {
    args.push("-sourcepath", opts.sourcePaths.join(delimiter));
  }

  if (opts.classpath.length > 0) {
    args.push("-classpath", opts.classpath.join(delimiter));
  }

  for (const url of opts.links) {
    args.push("-link", url);
  }

  args.push(...opts.sources);

  log.debug(
    `javadoc ${args.length} args (${opts.sources.length} sources, ${opts.classpath.length} cp)`,
  );

  return await new Promise<JavadocResult>((resolvePromise, rejectPromise) => {
    const child = spawn(opts.javadocPath ?? "javadoc", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stderrBuf: string[] = [];
    let warnings = 0;

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");

    child.stdout?.on("data", (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (line.length > 0) log.info(line);
      }
    });

    // Warnings count diagnostic-style lines (`<file>:<line>: warning: ...`).
    // The trailing summary line ("3 warnings") is emitted on stdout, so it
    // doesn't double-count here.
    child.stderr?.on("data", (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (line.length === 0) continue;
        stderrBuf.push(line);
        if (line.includes(": warning:")) warnings++;
        log.info(line);
      }
    });

    child.once("error", (err) => {
      rejectPromise(
        new Error(
          `Failed to spawn javadoc for project "${project.name}": ${(err as Error).message}`,
        ),
      );
    });

    child.once("close", (code) => {
      if (code === 0) {
        resolvePromise({ warnings });
        return;
      }
      const tail = stderrBuf.slice(-MAX_STDERR_LINES).join("\n");
      const suffix = stderrBuf.length > MAX_STDERR_LINES ? ` (last ${MAX_STDERR_LINES} lines)` : "";
      rejectPromise(
        new Error(
          `javadoc exited with code ${code} for project "${project.name}"${suffix}:\n${tail}`,
        ),
      );
    });
  });
}
