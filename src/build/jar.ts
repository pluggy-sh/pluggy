/**
 * Streaming zip helper used by the build and test pipelines to package a
 * staging directory into a deterministic jar (sorted entries, forward-slashed
 * paths). Lives here so both pipelines share one implementation.
 */

import { createReadStream, createWriteStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, posix, relative } from "node:path";

import yazl from "yazl";

export interface ZipOptions {
  /**
   * If provided, only entries whose forward-slashed relative path returns
   * `true` are included. Lets callers carve a subset out of a staged tree
   * without rebuilding it.
   */
  include?: (relPath: string) => boolean;
}

export async function zipDirectory(
  sourceDir: string,
  destPath: string,
  opts: ZipOptions = {},
): Promise<void> {
  const files = await collectFiles(sourceDir);
  files.sort((a, b) => a.localeCompare(b));

  return await new Promise<void>((resolvePromise, rejectPromise) => {
    const zip = new yazl.ZipFile();

    const ws = createWriteStream(destPath);
    ws.once("error", rejectPromise);
    ws.once("close", () => resolvePromise());
    zip.outputStream.pipe(ws);

    for (const abs of files) {
      const rel = toPosix(relative(sourceDir, abs));
      if (opts.include !== undefined && !opts.include(rel)) continue;
      zip.addReadStreamLazy(rel, (cb) => {
        try {
          cb(null, createReadStream(abs));
        } catch (e) {
          cb(e as Error, null as unknown as NodeJS.ReadableStream);
        }
      });
    }

    zip.end();
  });
}

async function collectFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
  }
  await walk(dir);
  return out;
}

function toPosix(p: string): string {
  return p.split(/[/\\]/).filter(Boolean).join(posix.sep);
}
