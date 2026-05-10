/**
 * Local-file resolver. Relative paths resolve against `ctx.rootDir`.
 * Jars are content-addressed: the SHA-256 of the bytes is both the cache
 * key and the integrity hash, so byte-identical sources share a cache
 * entry.
 */

import { createHash } from "node:crypto";
import { access, mkdir, readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { linkOrCopy } from "../portable.ts";
import { getCachePath } from "../project.ts";
import type { ResolvedSource } from "../source.ts";

import type { ResolveContext, ResolvedDependency } from "./index.ts";

/**
 * Resolve `file:<path>@<version>` into a content-addressed cached jar.
 * Throws when the source path does not exist or cannot be read.
 */
export async function resolveFile(
  path: string,
  version: string,
  ctx: ResolveContext,
): Promise<ResolvedDependency> {
  const normalized = path.replace(/\\/g, "/");
  const absSource = isAbsolute(normalized) ? resolve(normalized) : resolve(ctx.rootDir, normalized);

  try {
    await access(absSource);
  } catch (err) {
    throw new Error(
      `file source not found or unreadable: "${path}" (resolved to "${absSource}"): ${
        (err as Error).message
      }`,
    );
  }

  const bytes = await readFile(absSource);
  const hex = createHash("sha256").update(bytes).digest("hex");
  const integrity = `sha256-${hex}`;

  if (ctx.expectedIntegrity !== undefined && integrity !== ctx.expectedIntegrity) {
    throw new Error(
      `file: integrity check failed for "${path}": ` +
        `lockfile expects ${ctx.expectedIntegrity} but the file's bytes hash to ${integrity}. ` +
        `Re-run with --force to accept the new bytes (this overwrites the lockfile).`,
    );
  }

  const cacheDir = join(getCachePath(), "dependencies", "file");
  await mkdir(cacheDir, { recursive: true });
  const jarPath = join(cacheDir, `${hex}.jar`);

  // linkOrCopy: cache entry stays valid even if the source later moves;
  // same hex means same bytes, so overwrite is a cheap refresh, not a hazard.
  await linkOrCopy(absSource, jarPath);

  const source: ResolvedSource = { kind: "file", path: normalized, version };

  return {
    source,
    jarPath,
    integrity,
    transitiveDeps: [],
  };
}
