/**
 * javac driver. Never invokes a shell. Node's `spawn` handles `.exe` on
 * Windows automatically. Classpath joins use `delimiter` from `node:path`
 * (`:` on POSIX, `;` on Windows).
 */

import { spawn } from "node:child_process";
import { mkdir, readdir, stat } from "node:fs/promises";
import { delimiter, join } from "node:path";

import { log } from "../logging.ts";
import type { ResolvedProject } from "../project.ts";

export interface CompileOptions {
  sourceDir: string;
  outputDir: string;
  classpath: string[];
  /**
   * Absolute `javac` path. Defaults to `"javac"` (PATH lookup). Orchestrators
   * (`buildProject`, `runTests`, …) override with the SDK-resolved JDK so a
   * single JDK lookup serves the whole pipeline. Keeping `compileJava`
   * itself decoupled from the SDK module also avoids network-dependent unit
   * tests.
   */
  javacPath?: string;
}

const MAX_STDERR_LINES = 40;

/**
 * Compile every `.java` under `opts.sourceDir` into `opts.outputDir`.
 * On a non-zero javac exit, throws with the last 40 lines of stderr so CI
 * output stays readable.
 */
export async function compileJava(project: ResolvedProject, opts: CompileOptions): Promise<void> {
  const sources = await findJavaSources(opts.sourceDir);
  if (sources.length === 0) {
    throw new Error(
      `compile: no .java sources found under "${opts.sourceDir}" for project "${project.name}"`,
    );
  }

  await mkdir(opts.outputDir, { recursive: true });

  const args: string[] = ["-encoding", "UTF-8", "-d", opts.outputDir];
  if (opts.classpath.length > 0) {
    args.push("-cp", opts.classpath.join(delimiter));
  }
  args.push(...sources);

  log.debug(`javac ${args.length} args (${sources.length} sources, ${opts.classpath.length} cp)`);

  return await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(opts.javacPath ?? "javac", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stderrBuf: string[] = [];

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");

    child.stdout?.on("data", (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (line.length > 0) log.info(line);
      }
    });

    child.stderr?.on("data", (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (line.length === 0) continue;
        stderrBuf.push(line);
        log.info(line);
      }
    });

    child.once("error", (err) => {
      rejectPromise(
        new Error(
          `compile: failed to spawn javac for project "${project.name}": ${(err as Error).message}`,
        ),
      );
    });

    child.once("close", (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      const tail = stderrBuf.slice(-MAX_STDERR_LINES).join("\n");
      const suffix = stderrBuf.length > MAX_STDERR_LINES ? ` (last ${MAX_STDERR_LINES} lines)` : "";
      rejectPromise(
        new Error(
          `compile: javac exited with code ${code} for project "${project.name}"${suffix}:\n${tail}`,
        ),
      );
    });
  });
}

/**
 * Recursively collect every `.java` file under `dir`, sorted for deterministic
 * argv ordering. Exported for reuse by tooling that drives `javac`/`javadoc`
 * outside the build pipeline (for example, `pluggy docs`).
 */
export async function findJavaSources(dir: string): Promise<string[]> {
  const results: string[] = [];

  let info;
  try {
    info = await stat(dir);
  } catch (err) {
    throw new Error(
      `compile: source directory "${dir}" is not accessible: ${(err as Error).message}`,
    );
  }
  if (!info.isDirectory()) {
    throw new Error(`compile: source path "${dir}" is not a directory`);
  }

  async function walk(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".java")) {
        results.push(full);
      }
    }
  }

  await walk(dir);
  results.sort();
  return results;
}
