import { Command, InvalidArgumentError } from "commander";

import { bold, dim, emit, log } from "../logging.ts";

import { parseInteger, parseMcVersion } from "./parsers.ts";

const MODRINTH_API = "https://api.modrinth.com/v2";

/**
 * Loaders Modrinth indexes for plugins (`GET /v2/tag/loader`, filtered to
 * `supported_project_types` containing "plugin").
 *
 * `--platform` filters a Modrinth query, so it has to be validated against
 * Modrinth's vocabulary rather than pluggy's. Validating against pluggy's
 * platform registry accepted `travertine`, which Modrinth doesn't index, and
 * the search then returned zero hits as though nothing matched the query.
 * It also rejected `purpur`, `bungeecord`, and `geyser`, which Modrinth does
 * index but pluggy cannot build for.
 */
const MODRINTH_PLUGIN_LOADERS = [
  "bukkit",
  "bungeecord",
  "folia",
  "geyser",
  "paper",
  "purpur",
  "spigot",
  "sponge",
  "velocity",
  "waterfall",
] as const;

/** pluggy platform ids with no Modrinth loader, mapped to the nearest one. */
const LOADER_SUBSTITUTES: Record<string, string> = { travertine: "waterfall" };

export function parseSearchLoader(value: string): string {
  const id = value.toLowerCase();
  if ((MODRINTH_PLUGIN_LOADERS as readonly string[]).includes(id)) return id;
  const substitute = LOADER_SUBSTITUTES[id];
  if (substitute !== undefined) {
    throw new InvalidArgumentError(
      `Modrinth does not index "${id}" plugins. Search "${substitute}" instead.`,
    );
  }
  throw new InvalidArgumentError(
    `"${value}" is not a Modrinth plugin loader. Available: ${MODRINTH_PLUGIN_LOADERS.join(", ")}.`,
  );
}

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
  /** Minecraft (game) version filter, e.g. `1.21.8`. */
  mcVersion?: string;
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
  if (options.mcVersion) facets.push([`versions:${options.mcVersion}`]);

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
  log.info("");
  log.info(dim("Install with: pluggy install <slug>"));
  const seen = (result.page + 1) * result.size;
  if (result.hits.length === result.size && seen < result.total) {
    log.info(dim(`more: --page ${result.page + 1}`));
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
    .option("--size <size>", "Results per page.", parseInteger, 10)
    .option("--page <page>", "Zero-based page to fetch.", parseInteger, 0)
    .option(
      "--platform <loader>",
      "Filter by Modrinth loader (paper, velocity, …).",
      parseSearchLoader,
    )
    .option("--mc-version <version>", "Filter by Minecraft version (e.g. 1.21.8).", parseMcVersion)
    .action(async function action(this: Command, query: string, options) {
      await doSearch(query, {
        size: options.size,
        page: options.page,
        platform: options.platform,
        mcVersion: options.mcVersion,
      });
    });
}
