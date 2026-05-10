/**
 * Resource staging. Walks `project.resources`, copies files into staging,
 * and applies `${project.x}` substitution on text files whose extension is
 * on the allowlist. First-declared entry wins on output-path collisions;
 * duplicates are skipped with a warning.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, posix, resolve } from "node:path";

import { log } from "../logging.ts";
import { linkOrCopy, writeFileLF } from "../portable.ts";
import type { ResolvedProject } from "../project.ts";
import { replace } from "../template.ts";

const TEMPLATE_EXTENSIONS = new Set([".yml", ".yaml", ".json", ".properties", ".txt", ".md"]);

/**
 * Copy every entry in `project.resources` into `stagingDir`, applying
 * template substitution to allowlisted text extensions and hardlink-falling-
 * back-to-copy for everything else.
 */
export async function stageResources(project: ResolvedProject, stagingDir: string): Promise<void> {
  const resources = project.resources;
  if (resources === undefined || resources === null) return;

  const main = project.main ?? "";
  const className = main.length > 0 ? (main.split(".").pop() ?? "") : "";
  const packageName = main.length > 0 ? main.split(".").slice(0, -1).join(".") : "";
  const templateContext = {
    project: {
      ...project,
      className,
      packageName,
    },
  };

  const written = new Set<string>();

  // First-wins on conflicts depends on declaration-order iteration.
  for (const [outKey, srcRel] of Object.entries(resources)) {
    const srcAbs = resolveSourcePath(project.rootDir, srcRel);
    const isDir = outKey.endsWith("/");

    if (!existsSync(srcAbs)) {
      throw new Error(
        `resources: source path "${srcRel}" (key "${outKey}") does not exist at "${srcAbs}"`,
      );
    }

    if (isDir) {
      await copyDirectory(srcAbs, srcAbs, outKey, stagingDir, templateContext, written);
    } else {
      await copyFile(srcAbs, outKey, stagingDir, templateContext, written);
    }
  }
}

function resolveSourcePath(rootDir: string, rel: string): string {
  const normalized = rel.replace(/\\/g, "/");
  if (isAbsolute(normalized)) return resolve(normalized);
  return resolve(rootDir, normalized);
}

async function copyDirectory(
  dirRoot: string,
  currentDir: string,
  outPrefix: string,
  stagingDir: string,
  templateContext: Record<string, unknown>,
  written: Set<string>,
): Promise<void> {
  const entries = await readdir(currentDir);
  for (const name of entries) {
    const childAbs = join(currentDir, name);
    const info = await stat(childAbs);
    // Zip entry paths are always forward-slashed, regardless of host OS.
    const relFromRoot = childAbs
      .slice(dirRoot.length + 1)
      .split(/[/\\]/)
      .join("/");
    const outPath = outPrefix + relFromRoot;

    if (info.isDirectory()) {
      await copyDirectory(dirRoot, childAbs, outPrefix, stagingDir, templateContext, written);
    } else if (info.isFile()) {
      await writeEntry(childAbs, outPath, stagingDir, templateContext, written);
    }
    // Symlinks and specials are skipped; jar entries only support files.
  }
}

async function copyFile(
  srcAbs: string,
  outPath: string,
  stagingDir: string,
  templateContext: Record<string, unknown>,
  written: Set<string>,
): Promise<void> {
  const info = await stat(srcAbs);
  if (!info.isFile()) {
    throw new Error(
      `resources: source "${srcAbs}" for output key "${outPath}" is not a regular file`,
    );
  }
  await writeEntry(srcAbs, outPath, stagingDir, templateContext, written);
}

async function writeEntry(
  srcAbs: string,
  outPath: string,
  stagingDir: string,
  templateContext: Record<string, unknown>,
  written: Set<string>,
): Promise<void> {
  // POSIX-normalize the written-set key so OS separators don't produce
  // phantom collisions.
  const key = posix.normalize(outPath);
  if (written.has(key)) {
    log.warn(
      `resources: skipping "${outPath}": an earlier entry already resolved to the same output path`,
    );
    return;
  }
  written.add(key);

  const destination = join(stagingDir, key);
  await mkdir(dirname(destination), { recursive: true });

  const ext = extname(srcAbs).toLowerCase();
  if (TEMPLATE_EXTENSIONS.has(ext)) {
    const raw = await readFile(srcAbs, "utf8");
    const substituted = replace(raw, templateContext);
    await writeFileLF(destination, substituted);
  } else {
    await linkOrCopy(srcAbs, destination);
  }
}
