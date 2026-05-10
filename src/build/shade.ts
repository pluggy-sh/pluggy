/**
 * Shading. Selectively copy entries from dependency jars into the staging
 * directory per the project's `shading` rules. A dep without a rule is not
 * shaded.
 */

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, posix } from "node:path";

import yauzl, { type Entry, type ZipFile } from "yauzl";

import { log } from "../logging.ts";
import { safeJoin } from "../portable.ts";
import type { Shading } from "../project.ts";
import type { ResolvedDependency } from "../resolver/index.ts";
import { PENDING_BUILD_INTEGRITY } from "../resolver/workspace.ts";

/**
 * The dep's name as declared in `project.json`: the key the `shading` map
 * is indexed by. Slug for modrinth, artifactId for maven, basename without
 * `.jar` for file, name for workspace.
 */
function depName(dep: ResolvedDependency): string {
  switch (dep.source.kind) {
    case "modrinth":
      return dep.source.slug;
    case "maven":
      return dep.source.artifactId;
    case "file": {
      const p = dep.source.path.replace(/\\/g, "/");
      const base = p.slice(p.lastIndexOf("/") + 1);
      return base.toLowerCase().endsWith(".jar") ? base.slice(0, -4) : base;
    }
    case "workspace":
      return dep.source.name;
  }
}

/**
 * Apply every matching shading rule across `deps`, writing selected entries
 * into `stagingDir`. An entry is copied iff it matches at least one include
 * pattern and no exclude pattern.
 */
export async function applyShading(
  deps: ResolvedDependency[],
  rules: Record<string, Shading>,
  stagingDir: string,
): Promise<void> {
  for (const dep of deps) {
    const name = depName(dep);
    const rule = rules[name];
    if (rule === undefined) continue;

    if (dep.integrity === PENDING_BUILD_INTEGRITY) {
      if (!existsSync(dep.jarPath)) {
        throw new Error(
          `shade: workspace dependency "${name}" has not been built yet; expected jar at "${dep.jarPath}". Build the sibling workspace first (topological order is the caller's responsibility).`,
        );
      }
    }

    if (!existsSync(dep.jarPath)) {
      throw new Error(
        `shade: dependency "${name}" jar not found at "${dep.jarPath}"; resolve it first`,
      );
    }

    await shadeDependency(name, dep.jarPath, rule, stagingDir);
  }
}

async function shadeDependency(
  name: string,
  jarPath: string,
  rule: Shading,
  stagingDir: string,
): Promise<void> {
  const includes = rule.include ?? ["**"];
  const excludes = rule.exclude ?? [];

  await new Promise<void>((resolvePromise, rejectPromise) => {
    // autoClose:false: with the default, yauzl closes the FD on `end`,
    // which races against openReadStream calls we queue from the entry loop.
    yauzl.open(jarPath, { lazyEntries: true, autoClose: false }, (err, zip) => {
      if (err !== null || zip === undefined) {
        rejectPromise(
          new Error(
            `shade: failed to open jar for "${name}" at "${jarPath}": ${err?.message ?? "unknown error"}`,
          ),
        );
        return;
      }

      const extractQueue: Entry[] = [];
      let errored = false;

      const onEnd = async (): Promise<void> => {
        try {
          for (const entry of extractQueue) {
            await extractEntry(zip, entry, stagingDir, name);
          }
          resolvePromise();
        } catch (e) {
          rejectPromise(e as Error);
        } finally {
          zip.close();
        }
      };

      zip.on("entry", (entry: Entry) => {
        if (errored) return;
        if (entry.fileName.endsWith("/")) {
          zip.readEntry();
          return;
        }
        if (matches(entry.fileName, includes) && !matches(entry.fileName, excludes)) {
          extractQueue.push(entry);
        }
        zip.readEntry();
      });

      zip.once("end", () => {
        void onEnd();
      });

      zip.once("error", (e: Error) => {
        errored = true;
        rejectPromise(
          new Error(`shade: error reading jar for "${name}" at "${jarPath}": ${e.message}`),
        );
      });

      zip.readEntry();
    });
  });
}

function extractEntry(
  zip: ZipFile,
  entry: Entry,
  stagingDir: string,
  depName: string,
): Promise<void> {
  return new Promise<void>((resolvePromise, rejectPromise) => {
    zip.openReadStream(entry, async (err, stream) => {
      if (err !== null || stream === undefined) {
        rejectPromise(
          new Error(
            `shade: failed to read entry "${entry.fileName}" from "${depName}": ${err?.message ?? "unknown error"}`,
          ),
        );
        return;
      }
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.once("end", async () => {
        try {
          const data = Buffer.concat(chunks);
          let dest: string;
          try {
            dest = safeJoin(stagingDir, entry.fileName);
          } catch (e) {
            throw new Error(
              `shade: refusing entry "${entry.fileName}" from "${depName}": ${(e as Error).message}`,
            );
          }
          await mkdir(dirname(dest), { recursive: true });
          await writeFile(dest, data);
          log.debug(`shade: ${depName} -> ${entry.fileName} (${data.length}b)`);
          resolvePromise();
        } catch (e) {
          rejectPromise(e as Error);
        }
      });
      stream.once("error", (e: Error) => {
        rejectPromise(
          new Error(`shade: stream error on "${entry.fileName}" from "${depName}": ${e.message}`),
        );
      });
    });
  });
}

/**
 * Match `path` against any of `patterns`. `*` matches one path segment,
 * `**` matches any depth (including zero segments). Leading `/` on either
 * side is normalized away.
 */
export function matches(path: string, patterns: string[]): boolean {
  if (patterns.length === 0) return false;
  const normalizedPath = posix.normalize(path).replace(/^\/+/, "");
  for (const raw of patterns) {
    const pattern = raw.replace(/^\/+/, "");
    if (matchGlob(normalizedPath, pattern)) return true;
  }
  return false;
}

function matchGlob(path: string, pattern: string): boolean {
  // `**/` → `(?:.*?/)?`, `**` alone → `.*`, `*` → `[^/]*`, `?` → `[^/]`.
  // Process `**` first so it doesn't collide with `*`.
  let re = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "*" && pattern[i + 1] === "*") {
      if (pattern[i + 2] === "/") {
        re += "(?:.*?/)?";
        i += 3;
        continue;
      }
      re += ".*";
      i += 2;
      continue;
    }
    if (ch === "*") {
      re += "[^/]*";
      i += 1;
      continue;
    }
    if (ch === "?") {
      re += "[^/]";
      i += 1;
      continue;
    }
    if (/[.+^${}()|[\]\\]/.test(ch)) {
      re += `\\${ch}`;
    } else {
      re += ch;
    }
    i += 1;
  }
  const regex = new RegExp(`^${re}$`);
  return regex.test(path);
}
