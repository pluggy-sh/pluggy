import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import process from "node:process";

import { Command } from "commander";

import { bold, dim, emit, log } from "../logging.ts";
import { parseIdentifier, type ResolvedSource } from "../source.ts";
import { resolveWorkspaceContext } from "../workspace.ts";

import { parseIdentifierArg } from "./parsers.ts";

const MODRINTH_API = "https://api.modrinth.com/v2";

interface ModrinthProject {
  slug?: string;
  title?: string;
  description?: string;
  body?: string;
  project_url?: string;
  source_url?: string;
  wiki_url?: string;
  discord_url?: string;
  issues_url?: string;
  license?: { id?: string; name?: string; url?: string | null } | string | null;
  game_versions?: string[];
  versions?: string[];
}

interface ModrinthVersion {
  id: string;
  name?: string;
  version_number: string;
  version_type: "release" | "beta" | "alpha";
  date_published: string;
  game_versions: string[];
  loaders?: string[];
  downloads?: number;
  files?: { size?: number }[];
}

export interface InfoOptions {
  project?: string;
}

export interface InfoResult {
  source: ResolvedSource;
  [key: string]: unknown;
}

/**
 * Resolve metadata about a plugin identifier. Dispatches per source kind:
 * Modrinth and workspace queries hit the network / disk, file returns size +
 * sha256, maven is a passthrough.
 *
 * When invoked inside a pluggy project, Modrinth hits are annotated with a
 * per-version compatibility hint against the project's `compatibility.versions`.
 */
export async function doInfo(identifier: string, _options: InfoOptions = {}): Promise<InfoResult> {
  const source = parseIdentifier(identifier);

  const ctx = resolveWorkspaceContext(process.cwd());
  const compatVersions =
    ctx?.current?.project.compatibility?.versions ?? ctx?.root.compatibility?.versions ?? [];

  let result: InfoResult;

  switch (source.kind) {
    case "modrinth":
      result = await infoModrinth(source, compatVersions);
      break;
    case "maven":
      result = infoMaven(source);
      break;
    case "file":
      result = infoFile(source);
      break;
    case "workspace":
      result = infoWorkspace(source, ctx);
      break;
  }

  emit({ status: "success", ...result }, () => {
    printHumanInfo(result);
  });

  return result;
}

async function infoModrinth(
  source: Extract<ResolvedSource, { kind: "modrinth" }>,
  compatVersions: string[],
): Promise<InfoResult> {
  const slug = source.slug;
  const projectUrl = `${MODRINTH_API}/project/${encodeURIComponent(slug)}`;
  const versionsUrl = `${projectUrl}/version`;

  const projectRes = await fetch(projectUrl);
  if (!projectRes.ok) {
    if (projectRes.status === 404) {
      throw new Error(`Modrinth: project "${slug}" not found (${projectUrl})`);
    }
    throw new Error(
      `Modrinth API request failed for "${slug}": ${projectRes.status} ${projectRes.statusText} (${projectUrl})`,
    );
  }
  const project = (await projectRes.json()) as ModrinthProject;

  const versionsRes = await fetch(versionsUrl);
  if (!versionsRes.ok) {
    throw new Error(
      `Modrinth API request failed for "${slug}" versions: ${versionsRes.status} ${versionsRes.statusText} (${versionsUrl})`,
    );
  }
  const versionsRaw = (await versionsRes.json()) as ModrinthVersion[];
  if (!Array.isArray(versionsRaw)) {
    throw new Error(`Modrinth API returned non-array version list for "${slug}"`);
  }

  const license =
    typeof project.license === "object" && project.license !== null
      ? (project.license.id ?? project.license.name ?? null)
      : (project.license ?? null);
  const homepage =
    project.source_url ?? project.wiki_url ?? project.issues_url ?? project.discord_url ?? null;

  const versions = versionsRaw.map((v) => {
    const entry: Record<string, unknown> = {
      id: v.id,
      version: v.version_number,
      date: v.date_published,
      type: v.version_type,
      game_versions: v.game_versions,
    };
    if (compatVersions.length > 0) {
      const overlap = v.game_versions.filter((gv) => compatVersions.includes(gv));
      entry.compatibility = overlap.length > 0 ? "ok" : "warn";
    }
    return entry;
  });

  return {
    source,
    kind: "modrinth",
    slug,
    title: project.title ?? slug,
    description: project.description ?? "",
    homepage,
    license,
    versions,
    modrinth_url: `https://modrinth.com/plugin/${slug}`,
  };
}

function infoMaven(source: Extract<ResolvedSource, { kind: "maven" }>): InfoResult {
  const coordinate = `${source.groupId}:${source.artifactId}`;
  return {
    source,
    kind: "maven",
    coordinate,
    version: source.version,
    note: "no version list available (Maven registries don't expose a uniform index; use your registry's UI)",
  };
}

function infoFile(source: Extract<ResolvedSource, { kind: "file" }>): InfoResult {
  const rawPath = source.path;
  const absPath = isAbsolute(rawPath) ? rawPath : resolve(process.cwd(), rawPath);
  if (!existsSync(absPath)) {
    throw new Error(`file not found: ${absPath} (from identifier "${rawPath}")`);
  }
  const stat = statSync(absPath);
  if (!stat.isFile()) {
    throw new Error(`not a regular file: ${absPath}`);
  }
  const bytes = readFileSync(absPath);
  const hash = createHash("sha256").update(bytes).digest("hex");
  return {
    source,
    kind: "file",
    path: absPath,
    size: stat.size,
    integrity: `sha256-${hash}`,
  };
}

function infoWorkspace(
  source: Extract<ResolvedSource, { kind: "workspace" }>,
  ctx: ReturnType<typeof resolveWorkspaceContext>,
): InfoResult {
  if (ctx === undefined) {
    throw new Error(
      `workspace:${source.name}: not inside a pluggy project (workspace identifiers are only meaningful within a repo)`,
    );
  }
  const node = ctx.workspaces.find((w) => w.name === source.name);
  if (node === undefined) {
    const known = ctx.workspaces.map((w) => w.name);
    const list = known.length > 0 ? known.join(", ") : "(none)";
    throw new Error(`workspace not found: "${source.name}". known workspaces: ${list}`);
  }
  return {
    source,
    kind: "workspace",
    name: node.name,
    version: node.project.version,
    main: node.project.main ?? null,
    root: node.root,
    projectFile: node.project.projectFile,
  };
}

function printHumanInfo(result: InfoResult): void {
  switch (result.kind) {
    case "modrinth": {
      log.info(bold(`${result.title as string}  ${dim(`(${result.slug as string})`)}`));
      if (result.description) log.info(`${result.description as string}`);
      if (result.homepage) log.info(`${dim("homepage:")} ${result.homepage as string}`);
      if (result.license) log.info(`${dim("license: ")} ${result.license as string}`);
      log.info(`${dim("url:     ")} ${result.modrinth_url as string}`);
      const versions = result.versions as Record<string, unknown>[];
      log.info("");
      log.info(bold("versions:"));
      for (const v of versions) {
        const compat = v.compatibility === undefined ? "" : ` [${v.compatibility as string}]`;
        log.info(
          `  ${v.version as string}  ${dim(v.type as string)}  ${dim(v.date as string)}${compat}`,
        );
      }
      break;
    }
    case "maven": {
      log.info(bold(`maven:${result.coordinate as string}`));
      log.info(`${dim("version:")} ${result.version as string}`);
      log.info(dim(result.note as string));
      break;
    }
    case "file": {
      log.info(bold(`file:${result.path as string}`));
      log.info(`${dim("size:     ")} ${String(result.size)} bytes`);
      log.info(`${dim("integrity:")} ${result.integrity as string}`);
      break;
    }
    case "workspace": {
      log.info(bold(`workspace:${result.name as string}`));
      log.info(`${dim("version:")} ${result.version as string}`);
      if (result.main) log.info(`${dim("main:   ")} ${result.main as string}`);
      log.info(`${dim("root:   ")} ${result.root as string}`);
      break;
    }
  }
}

/** Factory for the `pluggy info` commander command. */
export function infoCommand(): Command {
  return new Command("info")
    .alias("show")
    .description("Show information about a plugin, including available versions and compatibility.")
    .argument("<plugin>", "Plugin identifier.", parseIdentifierArg)
    .action(async function action(this: Command, plugin: string) {
      const globalOpts = this.optsWithGlobals();
      await doInfo(plugin, { project: globalOpts.project });
    });
}
