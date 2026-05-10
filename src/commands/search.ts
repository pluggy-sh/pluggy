import { Command } from "commander";

import { bold, dim, emit, log } from "../logging.ts";

import { parseInteger, parsePlatform, parseSemver } from "./parsers.ts";

const MODRINTH_API = "https://api.modrinth.com/v2";

interface ModrinthSearchHit {
  slug: string;
  title: string;
  description?: string;
  categories?: string[];
  client_side?: string;
  server_side?: string;
  /** Always "mod"; Modrinth folds plugins under "mod" + category tags. */
  project_type?: string;
  downloads?: number;
  follows?: number;
  icon_url?: string;
  project_id?: string;
  author?: string;
  display_categories?: string[];
  /** Supported Minecraft (game) versions, not plugin versions. */
  versions?: string[];
  /** Opaque Modrinth version ID, not a semver. */
  latest_version?: string;
  license?: string;
}

interface ModrinthSearchResponse {
  hits: ModrinthSearchHit[];
  offset: number;
  limit: number;
  total_hits: number;
}

export interface SearchOptions {
  size: number;
  page: number;
  platform?: string;
  version?: string;
}

export interface SearchResult {
  hits: ModrinthSearchHit[];
  page: number;
  size: number;
  total: number;
}

/**
 * Query Modrinth's `/v2/search` endpoint with the `project_type:plugin` facet
 * plus optional platform / MC-version filters. Returns the hits plus paging
 * metadata. Emits human output (or a JSON envelope) as a side effect.
 */
export async function doSearch(query: string, options: SearchOptions): Promise<SearchResult> {
  if (typeof query !== "string" || query.length === 0) {
    throw new Error('search query must be a non-empty string (got "")');
  }

  const facets: string[][] = [["project_type:plugin"]];
  if (options.platform) facets.push([`categories:${options.platform}`]);
  if (options.version) facets.push([`versions:${options.version}`]);

  const params = new URLSearchParams();
  params.set("query", query);
  params.set("limit", String(options.size));
  params.set("offset", String(options.size * options.page));
  params.set("facets", JSON.stringify(facets));

  const url = `${MODRINTH_API}/search?${params.toString()}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `Modrinth search failed for "${query}": ${res.status} ${res.statusText} (${url})`,
    );
  }
  const data = (await res.json()) as ModrinthSearchResponse;
  if (data === null || typeof data !== "object" || !Array.isArray(data.hits)) {
    throw new Error(`Modrinth search returned malformed response for "${query}" (${url})`);
  }

  const result: SearchResult = {
    hits: data.hits,
    page: options.page,
    size: options.size,
    total: data.total_hits ?? data.hits.length,
  };

  emit({ status: "success", ...result }, () => {
    printHumanSearch(query, result);
  });

  return result;
}

function truncate(s: string | undefined, max: number): string {
  if (!s) return "";
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + "…";
}

function printHumanSearch(query: string, result: SearchResult): void {
  if (result.hits.length === 0) {
    log.info(dim(`No results for "${query}".`));
    return;
  }
  log.info(
    dim(
      `page ${result.page} • ${result.hits.length} of ${result.total} result${result.total === 1 ? "" : "s"}`,
    ),
  );
  for (const hit of result.hits) {
    const downloads = hit.downloads ?? 0;
    log.info("");
    log.info(`${bold(hit.title)}  ${dim(`(${hit.slug})`)}`);
    const desc = truncate(hit.description, 120);
    if (desc) log.info(`  ${desc}`);
    const mcRange = renderGameVersionRange(hit.versions);
    if (mcRange) log.info(`  ${dim(`MC: ${mcRange}`)}`);
    log.info(`  ${dim(`downloads: ${downloads.toLocaleString()}`)}`);
    log.info(`  ${dim(`https://modrinth.com/plugin/${hit.slug}`)}`);
  }
}

/**
 * Compact summary of the MC versions the hit supports: `"1.8.8 … 1.21.8"`
 * for a span, the single version when one, or `""` when unknown.
 *
 * Sorts by numeric segment so "1.10.2" comes after "1.9.4".
 */
function renderGameVersionRange(versions: string[] | undefined): string {
  if (!versions || versions.length === 0) return "";
  if (versions.length === 1) return versions[0];
  const sorted = [...versions].sort(compareGameVersion);
  return `${sorted[0]} … ${sorted[sorted.length - 1]}`;
}

function compareGameVersion(a: string, b: string): number {
  const aParts = a.split(/[.-]/).map((s) => Number.parseInt(s, 10) || 0);
  const bParts = b.split(/[.-]/).map((s) => Number.parseInt(s, 10) || 0);
  const len = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < len; i++) {
    const diff = (aParts[i] ?? 0) - (bParts[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Factory for the `pluggy search` commander command. */
export function searchCommand(): Command {
  return new Command("search")
    .description("Search Modrinth for plugins by keyword.")
    .argument("<query>", "Search query.")
    .option("--size <size>", "Page size (default: 10).", parseInteger, 10)
    .option("--page <page>", "Page number (default: 0).", parseInteger, 0)
    .option("--platform <name>", "Filter by platform.", parsePlatform)
    .option("--version <semver>", "Filter by Minecraft version.", parseSemver)
    .action(async function action(this: Command, query: string, options) {
      await doSearch(query, {
        size: options.size,
        page: options.page,
        platform: options.platform,
        version: options.version,
      });
    });
}
