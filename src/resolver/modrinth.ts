/**
 * Modrinth resolver. Fetches the version list for a slug, picks a concrete
 * version (honouring `includePrerelease`), and downloads the primary jar
 * into the user cache.
 *
 * Integrity is verified at two levels:
 *   1. Modrinth's API publishes `hashes.sha512` for every file. Every
 *      download (fresh or cache-hit) is re-verified against this value, so
 *      a registry-side substitution or cache poisoning between runs is
 *      caught before the jar reaches `build` / `dev`.
 *   2. When the caller passes `ctx.expectedIntegrity` (the lockfile's
 *      recorded `sha256-<hex>` for this dep), the resolved bytes must
 *      match it too. Lets `install` refuse silent rolls forward across
 *      pinned versions.
 */

import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { getCachePath } from "../project.ts";
import type { ResolvedSource } from "../source.ts";

import type { ResolveContext, ResolvedDependency } from "./index.ts";

const MODRINTH_API = "https://api.modrinth.com/v2";
const LATEST_STABLE = "*";

interface ModrinthFile {
  url: string;
  filename: string;
  primary: boolean;
  hashes: { sha1?: string; sha512?: string };
}

interface ModrinthVersion {
  id: string;
  version_number: string;
  version_type: "release" | "beta" | "alpha";
  files: ModrinthFile[];
}

/**
 * Resolve `modrinth:<slug>@<version>` into a cached jar. `version === "*"`
 * picks the newest (stable unless `ctx.includePrerelease`).
 */
export async function resolveModrinth(
  slug: string,
  version: string,
  ctx: ResolveContext,
): Promise<ResolvedDependency> {
  const versions = await fetchVersions(slug);
  const picked = pickVersion(slug, version, versions, ctx.includePrerelease);
  const file = pickPrimaryFile(slug, picked);

  const cacheDir = join(getCachePath(), "dependencies", "modrinth", slug);
  await mkdir(cacheDir, { recursive: true });
  const jarPath = join(cacheDir, `${picked.version_number}.jar`);

  // Cache-hit path: confirm the bytes match Modrinth's published sha512
  // before reusing them. A poisoned cache (manual write, malicious tooling,
  // older buggy resolver) is caught here rather than executed at runtime.
  if (await fileExists(jarPath)) {
    if (!(await cachedFileMatchesSha512(jarPath, file.hashes.sha512))) {
      await rm(jarPath, { force: true });
      await downloadTo(file.url, jarPath, slug, picked.version_number);
    }
  } else {
    await downloadTo(file.url, jarPath, slug, picked.version_number);
  }

  await verifyAgainstApiHash(jarPath, slug, picked.version_number, file.hashes);

  const integrity = await sha256OfFile(jarPath);

  if (ctx.expectedIntegrity !== undefined && integrity !== ctx.expectedIntegrity) {
    throw new Error(
      `modrinth: integrity check failed for "${slug}@${picked.version_number}": ` +
        `lockfile expects ${ctx.expectedIntegrity} but resolved bytes are ${integrity}. ` +
        `Re-run with --force to accept the new bytes (this overwrites the lockfile).`,
    );
  }

  const source: ResolvedSource = {
    kind: "modrinth",
    slug,
    version: picked.version_number,
  };

  return {
    source,
    jarPath,
    integrity,
    transitiveDeps: [],
  };
}

/**
 * Return the version number of the newest Modrinth release for a slug. Used
 * by `list --outdated` and `doctor` to compare the lockfile against upstream
 * without downloading the jar. With `includePrerelease`, `beta`/`alpha`
 * releases are eligible; otherwise only `release` versions. Returns
 * `undefined` when the project has no versions of the requested maturity.
 */
export async function getLatestModrinthVersion(
  slug: string,
  includePrerelease: boolean,
): Promise<string | undefined> {
  const versions = await fetchVersions(slug);
  const eligible = includePrerelease
    ? versions
    : versions.filter((v) => v.version_type === "release");
  if (eligible.length === 0) return undefined;
  return eligible[0].version_number;
}

async function fetchVersions(slug: string): Promise<ModrinthVersion[]> {
  const url = `${MODRINTH_API}/project/${encodeURIComponent(slug)}/version`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `Modrinth API request failed for slug "${slug}": ${res.status} ${res.statusText} (${url})`,
    );
  }
  const data = (await res.json()) as ModrinthVersion[];
  if (!Array.isArray(data)) {
    throw new Error(`Modrinth API returned non-array response for slug "${slug}" at ${url}`);
  }
  return data;
}

function pickVersion(
  slug: string,
  version: string,
  versions: ModrinthVersion[],
  includePrerelease: boolean,
): ModrinthVersion {
  if (versions.length === 0) {
    throw new Error(`Modrinth: no versions published for slug "${slug}"`);
  }

  if (version === LATEST_STABLE) {
    const eligible = includePrerelease
      ? versions
      : versions.filter((v) => v.version_type === "release");
    if (eligible.length === 0) {
      throw new Error(
        `Modrinth: no ${includePrerelease ? "" : "stable "}versions available for slug "${slug}"` +
          (includePrerelease ? "" : " (pass --beta to include pre-releases)"),
      );
    }
    // Modrinth orders versions newest-first; no re-sort needed.
    return eligible[0];
  }

  const hit = versions.find((v) => v.version_number === version);
  if (hit === undefined) {
    const sample = versions
      .slice(0, 3)
      .map((v) => v.version_number)
      .join(", ");
    throw new Error(
      `Modrinth: version "${version}" not found for slug "${slug}". available: ${sample}${
        versions.length > 3 ? ", ..." : ""
      }`,
    );
  }
  if (!includePrerelease && hit.version_type !== "release") {
    throw new Error(
      `Modrinth: version "${version}" of "${slug}" is a ${hit.version_type} release; pass --beta to install pre-releases`,
    );
  }
  return hit;
}

function pickPrimaryFile(slug: string, version: ModrinthVersion): ModrinthFile {
  if (version.files.length === 0) {
    throw new Error(
      `Modrinth: version "${version.version_number}" of "${slug}" has no downloadable files`,
    );
  }
  const primary = version.files.find((f) => f.primary);
  return primary ?? version.files[0];
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function downloadTo(
  url: string,
  destination: string,
  slug: string,
  versionNumber: string,
): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `Modrinth: failed to download "${slug}" version "${versionNumber}" from ${url}: ${res.status} ${res.statusText}`,
    );
  }
  if (res.body === null) {
    throw new Error(
      `Modrinth: empty response body downloading "${slug}" version "${versionNumber}" from ${url}`,
    );
  }
  const nodeStream = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
  await pipeline(nodeStream, createWriteStream(destination));
}

async function sha256OfFile(path: string): Promise<string> {
  const bytes = await readFile(path);
  const hash = createHash("sha256").update(bytes).digest("hex");
  return `sha256-${hash}`;
}

async function cachedFileMatchesSha512(
  path: string,
  expectedSha512: string | undefined,
): Promise<boolean> {
  // No upstream hash → can't verify; trust the cache. Modrinth always emits
  // sha512 today, but the type marks it optional so be defensive.
  if (expectedSha512 === undefined || expectedSha512.length === 0) return true;
  const bytes = await readFile(path);
  const actual = createHash("sha512").update(bytes).digest("hex");
  return actual === expectedSha512.toLowerCase();
}

async function verifyAgainstApiHash(
  jarPath: string,
  slug: string,
  versionNumber: string,
  hashes: ModrinthFile["hashes"],
): Promise<void> {
  const expected = hashes.sha512;
  if (expected === undefined || expected.length === 0) return;
  const bytes = await readFile(jarPath);
  const actual = createHash("sha512").update(bytes).digest("hex");
  if (actual !== expected.toLowerCase()) {
    throw new Error(
      `modrinth: sha512 mismatch for "${slug}@${versionNumber}": ` +
        `Modrinth published ${expected} but downloaded bytes hash to ${actual}. ` +
        `Refusing to use a tampered jar.`,
    );
  }
}
