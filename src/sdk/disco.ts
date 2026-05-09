/**
 * Foojay Disco API client. Pure HTTP, no FS. The install pipeline consumes
 * what this returns. Disco aggregates JDK distributions (Temurin, Zulu,
 * Liberica, Corretto, Microsoft, GraalVM CE, …) and exposes a single query
 * surface for "give me JDK <major> for <os>/<arch>".
 *
 * Docs: https://github.com/foojayio/discoapi
 *
 * The package-list response omits checksum fields, so we make a second
 * `GET /packages/{id}` request after picking a package to retrieve them.
 * `installJdk` refuses to extract bytes whose hash doesn't match.
 */

import process from "node:process";

const DISCO_BASE = "https://api.foojay.io/disco/v3.0";
const REQUEST_TIMEOUT_MS = 10_000;

/** OS names Disco accepts. Mirrors `process.platform` mapping in `targetForHost`. */
export type DiscoOs = "macos" | "linux" | "windows";
/** Arch names Disco accepts. */
export type DiscoArch = "aarch64" | "x64";
/** Archive type per OS: Unix ships tarballs, Windows ships zips. */
export type DiscoArchiveType = "tar.gz" | "zip";

/** Resolved package metadata sufficient to download and extract a JDK. */
export interface JdkSpec {
  /** Disco distribution slug, for example "temurin", "graalvm_community". */
  distribution: string;
  /** Major release, for example 21. */
  major: number;
  /** Full Java version string from Disco, for example "21.0.11+10". */
  fullVersion: string;
  os: DiscoOs;
  arch: DiscoArch;
  archiveType: DiscoArchiveType;
  /** Disco redirect URL; fetch follows it transparently to the upstream CDN. */
  downloadUrl: string;
  /** Filename Disco reports for the archive; used for caching the download. */
  filename: string;
  /** Package size in bytes when Disco knows it; `undefined` otherwise. */
  sizeBytes?: number;
  /**
   * Cryptographic hash published by the JDK vendor and surfaced via Disco's
   * per-package endpoint. `installJdk` verifies the downloaded bytes match
   * before extraction; `undefined` if the vendor doesn't publish one (rare;
   * we log a warning but don't block on it for backward compatibility).
   */
  checksum?: { algorithm: "sha256" | "sha512" | "sha1" | "md5"; value: string };
}

export interface ResolveJdkOptions {
  major: number;
  /** Disco distribution slug. Default `"temurin"`. */
  distribution?: string;
  /** Override host detection. */
  os?: DiscoOs;
  /** Override host detection. */
  arch?: DiscoArch;
}

/**
 * Resolve a single Disco package matching the requested major/distribution
 * for the given (or detected) host. Picks the latest GA build available.
 *
 * Throws when Disco returns no matches; that surfaces as a clean error to
 * the user (typically: "this major isn't published for your OS/arch").
 */
export async function resolveJdk(opts: ResolveJdkOptions): Promise<JdkSpec> {
  const distribution = opts.distribution ?? "temurin";
  const target =
    opts.os !== undefined && opts.arch !== undefined
      ? { os: opts.os, arch: opts.arch }
      : targetForHost();
  const archiveType: DiscoArchiveType = target.os === "windows" ? "zip" : "tar.gz";

  const url = new URL(`${DISCO_BASE}/packages`);
  url.searchParams.set("distribution", distribution);
  url.searchParams.set("version", String(opts.major));
  url.searchParams.set("package_type", "jdk");
  url.searchParams.set("operating_system", target.os);
  url.searchParams.set("architecture", target.arch);
  url.searchParams.set("archive_type", archiveType);
  url.searchParams.set("latest", "available");
  url.searchParams.set("javafx_bundled", "false");
  url.searchParams.set("directly_downloadable", "true");
  url.searchParams.set("release_status", "ga");

  const data = await fetchJson(url);
  const items = (data as DiscoListResponse).result ?? [];
  if (items.length === 0) {
    throw new Error(
      `disco: no ${distribution} JDK ${opts.major} (${target.os}/${target.arch}, ${archiveType}); ` +
        `try a different distribution or check https://api.foojay.io/disco/v3.0/distributions`,
    );
  }

  const pkg = items[0];
  const downloadUrl = pkg.links?.pkg_download_redirect;
  if (typeof downloadUrl !== "string" || downloadUrl.length === 0) {
    throw new Error(`disco: package ${pkg.id ?? "?"} returned no pkg_download_redirect link`);
  }

  const checksum =
    typeof pkg.id === "string" && pkg.id.length > 0 && typeof pkg.links?.pkg_info_uri === "string"
      ? await fetchPackageChecksum(pkg.links.pkg_info_uri)
      : undefined;

  return {
    distribution: pkg.distribution,
    major: pkg.major_version,
    fullVersion: pkg.java_version,
    os: target.os,
    arch: target.arch,
    archiveType,
    downloadUrl,
    filename: pkg.filename,
    sizeBytes: typeof pkg.size === "number" ? pkg.size : undefined,
    checksum,
  };
}

/**
 * Fetch the per-package detail endpoint to recover the vendor-published
 * checksum. Returns `undefined` on any failure (network, missing field,
 * unsupported algorithm); `installJdk` logs a warning and proceeds without
 * verification in that case rather than refusing every install.
 *
 * `checksum_uri` (when present) points to a text file containing the digest
 * value. Some vendors include the hash inline as `checksum`, others only as
 * a sidecar URL; we handle both.
 */
async function fetchPackageChecksum(pkgInfoUri: string): Promise<JdkSpec["checksum"] | undefined> {
  const data = await fetchJson(new URL(pkgInfoUri)).catch(() => undefined);
  if (data === undefined) return undefined;
  const result = (data as DiscoPackageInfoResponse).result;
  if (!Array.isArray(result) || result.length === 0) return undefined;
  const info = result[0];

  const rawType = (info.checksum_type ?? "").toLowerCase();
  if (rawType !== "sha256" && rawType !== "sha512" && rawType !== "sha1" && rawType !== "md5") {
    return undefined;
  }

  let value = info.checksum;
  if ((value === undefined || value.length === 0) && typeof info.checksum_uri === "string") {
    value = await fetchChecksumSidecar(info.checksum_uri);
  }
  if (value === undefined || value.length === 0) return undefined;

  // Sidecar files often look like "<hex>  filename"; take the leading hex
  // token. Hashes are case-insensitive; normalize to lowercase for compare.
  const trimmed = value.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (!/^[0-9a-f]+$/.test(trimmed)) return undefined;

  return { algorithm: rawType, value: trimmed };
}

async function fetchChecksumSidecar(url: string): Promise<string | undefined> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) return undefined;
      return await res.text();
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return undefined;
  }
}

interface DiscoPackageInfoResponse {
  result?: DiscoPackageInfo[];
}

interface DiscoPackageInfo {
  filename?: string;
  direct_download_uri?: string;
  checksum?: string;
  checksum_type?: string;
  checksum_uri?: string;
}

/** Map `process.platform` + `process.arch` to Disco's naming. */
export function targetForHost(): { os: DiscoOs; arch: DiscoArch } {
  let os: DiscoOs;
  if (process.platform === "darwin") os = "macos";
  else if (process.platform === "linux") os = "linux";
  else if (process.platform === "win32") os = "windows";
  else throw new Error(`disco: unsupported platform "${process.platform}"`);

  let arch: DiscoArch;
  if (process.arch === "arm64") arch = "aarch64";
  else if (process.arch === "x64") arch = "x64";
  else
    throw new Error(`disco: unsupported arch "${process.arch}"; only aarch64 and x64 are mapped`);

  return { os, arch };
}

interface DiscoListResponse {
  result?: DiscoPackage[];
  message?: string;
}

interface DiscoPackage {
  id?: string;
  archive_type: DiscoArchiveType;
  distribution: string;
  major_version: number;
  java_version: string;
  operating_system: DiscoOs;
  architecture: DiscoArch;
  filename: string;
  size?: number;
  links?: {
    pkg_info_uri?: string;
    pkg_download_redirect?: string;
  };
}

async function fetchJson(url: URL): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { accept: "application/json" },
    });
    if (!res.ok) {
      throw new Error(`disco: ${res.status} ${res.statusText}: ${url.toString()}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}
