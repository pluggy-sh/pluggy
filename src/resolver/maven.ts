/**
 * Maven resolver. Walks `ctx.registries` in order, downloading the requested
 * jar. SNAPSHOT versions require a metadata lookup because published jars
 * are stored under timestamped filenames, not the declared version.
 *
 * Transitive dependencies are resolved by parsing the artifact's POM. The
 * resolver understands direct `<dependencies>` with `compile` / `runtime` /
 * unscoped entries, and `<dependencyManagement>` BOM imports (`<type>pom</type>`
 * `<scope>import</scope>`). Property expansion and parent-POM inheritance are
 * NOT implemented — an unresolved `${...}` placeholder in a version is
 * logged and the entry is skipped.
 */

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { log } from "../logging.ts";
import { getCachePath } from "../project.ts";
import type { ResolvedSource } from "../source.ts";

import type { ResolveContext, ResolvedDependency } from "./index.ts";

const MAX_TRANSITIVE_DEPTH = 8;

interface PomDep {
  groupId: string;
  artifactId: string;
  version: string;
  scope?: string;
  type?: string;
  optional?: boolean;
}

/**
 * Resolve a Maven coordinate into a cached jar plus its transitive closure.
 * Requires at least one entry in `ctx.registries`.
 */
export async function resolveMaven(
  groupId: string,
  artifactId: string,
  version: string,
  ctx: ResolveContext,
): Promise<ResolvedDependency> {
  if (!Array.isArray(ctx.registries) || ctx.registries.length === 0) {
    throw new Error(
      `Maven: no registries configured for "${groupId}:${artifactId}:${version}". Declare a Maven registry in project.json:registries.`,
    );
  }

  const visited = new Set<string>();
  return resolveOne(
    groupId,
    artifactId,
    version,
    ctx.registries,
    visited,
    0,
    ctx.expectedIntegrity,
  );
}

async function resolveOne(
  groupId: string,
  artifactId: string,
  version: string,
  registries: string[],
  visited: Set<string>,
  depth: number,
  expectedIntegrity?: string,
): Promise<ResolvedDependency> {
  const coord = `${groupId}:${artifactId}:${version}`;
  const key = `${groupId}:${artifactId}`;
  visited.add(key);

  const jarPath = cachedJarPath(groupId, artifactId, version);
  await mkdir(join(jarPath, ".."), { recursive: true });

  const errors: string[] = [];
  let downloadedFrom: string | undefined;
  let bytes: Uint8Array | undefined;

  let downloadedJarUrl: string | undefined;
  for (const registry of registries) {
    const base = stripTrailingSlash(registry);
    const jarUrl = await resolveJarUrl(base, groupId, artifactId, version, errors);
    if (jarUrl === undefined) continue;

    const fetched = await fetchBytes(jarUrl, errors);
    if (fetched === undefined) continue;

    bytes = fetched;
    downloadedFrom = base;
    downloadedJarUrl = jarUrl;
    break;
  }

  if (bytes === undefined || downloadedFrom === undefined || downloadedJarUrl === undefined) {
    throw new Error(
      `Maven: could not resolve "${coord}" from any configured registry. Tried:\n  ${errors.join("\n  ")}`,
    );
  }

  await verifyAgainstSidecar(downloadedJarUrl, bytes, coord);

  const integrity = `sha256-${createHash("sha256").update(bytes).digest("hex")}`;
  // Only enforce expected-integrity on the top-level resolve (depth 0); a
  // mismatch deeper in the tree means upstream advanced a transitive, which
  // is normal flux and out of scope for the lockfile-pin we're enforcing.
  if (depth === 0 && expectedIntegrity !== undefined && integrity !== expectedIntegrity) {
    throw new Error(
      `maven: integrity check failed for "${coord}" — ` +
        `lockfile expects ${expectedIntegrity} but resolved bytes are ${integrity}. ` +
        `Re-run with --force to accept the new bytes (this overwrites the lockfile).`,
    );
  }
  await writeFile(jarPath, bytes);
  const source: ResolvedSource = { kind: "maven", groupId, artifactId, version };

  const transitiveDeps =
    depth < MAX_TRANSITIVE_DEPTH
      ? await resolveTransitives(
          groupId,
          artifactId,
          version,
          downloadedFrom,
          registries,
          visited,
          depth,
        )
      : [];

  return { source, jarPath, integrity, transitiveDeps };
}

async function resolveTransitives(
  groupId: string,
  artifactId: string,
  version: string,
  originRegistry: string,
  registries: string[],
  visited: Set<string>,
  depth: number,
): Promise<ResolvedDependency[]> {
  const pomUrl = await resolvePomUrl(originRegistry, groupId, artifactId, version);
  if (pomUrl === undefined) return [];

  const pomErrors: string[] = [];
  const pomXml = await fetchText(pomUrl, pomErrors);
  if (pomXml === undefined) {
    log.debug(
      `maven: skipped transitives for ${groupId}:${artifactId}:${version} — ${pomErrors.join(", ")}`,
    );
    return [];
  }

  const managedVersions = await collectManagedVersions(pomXml, registries, visited, depth + 1);
  const deps = parsePomDependencies(pomXml);

  const resolved: ResolvedDependency[] = [];
  for (const dep of deps) {
    if (shouldSkipDep(dep)) continue;
    if (visited.has(`${dep.groupId}:${dep.artifactId}`)) continue;

    const concreteVersion = concretizeVersion(dep, managedVersions, groupId, artifactId, version);
    if (concreteVersion === undefined) {
      log.debug(
        `maven: skipped transitive ${dep.groupId}:${dep.artifactId} — version "${dep.version}" could not be resolved`,
      );
      continue;
    }

    try {
      const child = await resolveOne(
        dep.groupId,
        dep.artifactId,
        concreteVersion,
        registries,
        visited,
        depth + 1,
      );
      resolved.push(child);
    } catch (err) {
      log.debug(
        `maven: skipped transitive ${dep.groupId}:${dep.artifactId}:${concreteVersion} — ${(err as Error).message}`,
      );
    }
  }
  return resolved;
}

/**
 * Walk `<dependencyManagement>` and fold BOM imports (`<type>pom</type>` +
 * `<scope>import</scope>`) into a flat version map keyed by `group:artifact`.
 */
async function collectManagedVersions(
  pomXml: string,
  registries: string[],
  visited: Set<string>,
  depth: number,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const mgmt = extractBlock(pomXml, "dependencyManagement");
  if (mgmt === undefined) return map;

  const depsBlock = extractBlock(mgmt, "dependencies") ?? "";
  for (const dep of parseDependencyBlocks(depsBlock)) {
    if (dep.type === "pom" && dep.scope === "import") {
      if (depth >= MAX_TRANSITIVE_DEPTH) continue;
      await importBom(dep, registries, visited, depth, map);
      continue;
    }
    if (dep.version && !dep.version.includes("${")) {
      map.set(`${dep.groupId}:${dep.artifactId}`, dep.version);
    }
  }
  return map;
}

async function importBom(
  dep: PomDep,
  registries: string[],
  visited: Set<string>,
  depth: number,
  map: Map<string, string>,
): Promise<void> {
  if (!dep.version || dep.version.includes("${")) return;

  for (const registry of registries) {
    const base = stripTrailingSlash(registry);
    const pomUrl = await resolvePomUrl(base, dep.groupId, dep.artifactId, dep.version);
    if (pomUrl === undefined) continue;

    const errors: string[] = [];
    const pomXml = await fetchText(pomUrl, errors);
    if (pomXml === undefined) continue;

    const nested = await collectManagedVersions(pomXml, registries, visited, depth + 1);
    for (const [key, version] of nested) {
      if (!map.has(key)) map.set(key, version);
    }
    const deps = parsePomDependencies(pomXml);
    for (const d of deps) {
      if (d.version && !d.version.includes("${")) {
        const key = `${d.groupId}:${d.artifactId}`;
        if (!map.has(key)) map.set(key, d.version);
      }
    }
    return;
  }
}

function shouldSkipDep(dep: PomDep): boolean {
  if (dep.optional === true) return true;
  if (dep.type !== undefined && dep.type !== "jar") return true;
  const scope = dep.scope ?? "compile";
  return scope === "test" || scope === "provided" || scope === "system";
}

function concretizeVersion(
  dep: PomDep,
  managed: Map<string, string>,
  parentGroupId: string,
  parentArtifactId: string,
  parentVersion: string,
): string | undefined {
  if (dep.version.length === 0) {
    return managed.get(`${dep.groupId}:${dep.artifactId}`);
  }
  if (dep.version === "${project.version}" || dep.version === "${version}") {
    if (dep.groupId === parentGroupId && dep.artifactId !== parentArtifactId) return parentVersion;
    return parentVersion;
  }
  if (dep.version.includes("${")) {
    return managed.get(`${dep.groupId}:${dep.artifactId}`);
  }
  const range = parseMavenRange(dep.version);
  if (range !== undefined) return range;
  return dep.version;
}

/**
 * Maven versions can be declared as ranges like `[1.0,2.0)` or soft pins
 * `1.0`. For the soft-pin case return the string as-is. For ranges, return
 * the lower bound (good enough for transitive resolution — real Maven picks
 * the highest in-range available, but we don't need that fidelity for the
 * plugin-development use case).
 */
function parseMavenRange(raw: string): string | undefined {
  const match = raw.match(/^[[(]\s*([^,\s)\]]+)\s*,/);
  if (match) return match[1];
  if (/^\d/.test(raw)) return raw;
  return undefined;
}

function parsePomDependencies(pomXml: string): PomDep[] {
  const project = extractBlock(pomXml, "project");
  const sections = project ?? pomXml;
  const direct = extractBlock(sections, "dependencies", { skipNestedIn: "dependencyManagement" });
  if (direct === undefined) return [];
  return parseDependencyBlocks(direct);
}

function parseDependencyBlocks(block: string): PomDep[] {
  const entries: PomDep[] = [];
  const deps = block.match(/<dependency>[\s\S]*?<\/dependency>/g);
  if (!deps) return entries;

  for (const raw of deps) {
    const groupId = raw.match(/<groupId>([^<]+)<\/groupId>/)?.[1]?.trim();
    const artifactId = raw.match(/<artifactId>([^<]+)<\/artifactId>/)?.[1]?.trim();
    if (!groupId || !artifactId) continue;

    entries.push({
      groupId,
      artifactId,
      version: raw.match(/<version>([^<]+)<\/version>/)?.[1]?.trim() ?? "",
      scope: raw.match(/<scope>([^<]+)<\/scope>/)?.[1]?.trim(),
      type: raw.match(/<type>([^<]+)<\/type>/)?.[1]?.trim(),
      optional: raw.match(/<optional>([^<]+)<\/optional>/)?.[1]?.trim() === "true",
    });
  }
  return entries;
}

/**
 * Return the text between `<tag>` and `</tag>` at the top level of `xml`.
 * With `skipNestedIn`, skip any occurrence that appears inside the named
 * ancestor (used to pick direct `<dependencies>` and not
 * `<dependencyManagement>` > `<dependencies>`).
 */
function extractBlock(
  xml: string,
  tag: string,
  opts?: { skipNestedIn?: string },
): string | undefined {
  const skipIn = opts?.skipNestedIn;
  let skipStart = -1;
  let skipEnd = -1;
  if (skipIn) {
    const openSkip = xml.indexOf(`<${skipIn}>`);
    if (openSkip !== -1) {
      const closeSkip = xml.indexOf(`</${skipIn}>`, openSkip);
      if (closeSkip !== -1) {
        skipStart = openSkip;
        skipEnd = closeSkip + `</${skipIn}>`.length;
      }
    }
  }

  const openTag = `<${tag}>`;
  const closeTag = `</${tag}>`;
  let cursor = 0;
  while (cursor < xml.length) {
    const openIdx = xml.indexOf(openTag, cursor);
    if (openIdx === -1) return undefined;
    if (skipStart !== -1 && openIdx >= skipStart && openIdx < skipEnd) {
      cursor = skipEnd;
      continue;
    }
    const closeIdx = xml.indexOf(closeTag, openIdx);
    if (closeIdx === -1) return undefined;
    return xml.slice(openIdx + openTag.length, closeIdx);
  }
  return undefined;
}

async function resolveJarUrl(
  base: string,
  groupId: string,
  artifactId: string,
  version: string,
  errors: string[],
): Promise<string | undefined> {
  const resolved = await resolveSnapshotFilename(base, groupId, artifactId, version, "jar", errors);
  if (resolved === undefined) return undefined;
  return `${base}/${groupPath(groupId)}/${artifactId}/${version}/${artifactId}-${resolved}.jar`;
}

async function resolvePomUrl(
  base: string,
  groupId: string,
  artifactId: string,
  version: string,
): Promise<string | undefined> {
  const errors: string[] = [];
  const resolved = await resolveSnapshotFilename(base, groupId, artifactId, version, "pom", errors);
  if (resolved === undefined) return undefined;
  return `${base}/${groupPath(groupId)}/${artifactId}/${version}/${artifactId}-${resolved}.pom`;
}

/**
 * For release versions, return the version as-is (direct-path filename).
 * For SNAPSHOT versions, fetch per-version `maven-metadata.xml` and return
 * the timestamped value for the requested extension.
 */
async function resolveSnapshotFilename(
  base: string,
  groupId: string,
  artifactId: string,
  version: string,
  extension: "jar" | "pom",
  errors: string[],
): Promise<string | undefined> {
  if (!version.endsWith("-SNAPSHOT")) return version;

  const metaUrl = `${base}/${groupPath(groupId)}/${artifactId}/${version}/maven-metadata.xml`;
  const xml = await fetchText(metaUrl, errors);
  if (xml === undefined) return undefined;

  const resolved = parseSnapshotFilenameValue(xml, extension);
  if (resolved === undefined) {
    errors.push(`${metaUrl} -> no ${extension} <snapshotVersion> entry`);
    return undefined;
  }
  return resolved;
}

function parseSnapshotFilenameValue(xml: string, extension: "jar" | "pom"): string | undefined {
  const blocks = xml.match(/<snapshotVersion>[\s\S]*?<\/snapshotVersion>/g);
  if (!blocks) return undefined;
  for (const block of blocks) {
    if (/<classifier>/.test(block)) continue;
    const ext = block.match(/<extension>([^<]+)<\/extension>/)?.[1];
    if (ext !== extension) continue;
    const value = block.match(/<value>([^<]+)<\/value>/)?.[1];
    if (value) return value;
  }
  return undefined;
}

async function fetchBytes(url: string, errors: string[]): Promise<Uint8Array | undefined> {
  try {
    const res = await fetch(url);
    if (!res.ok) {
      errors.push(`${url} -> ${res.status} ${res.statusText}`);
      return undefined;
    }
    return new Uint8Array(await res.arrayBuffer());
  } catch (err) {
    errors.push(`${url} -> network error: ${(err as Error).message}`);
    return undefined;
  }
}

async function fetchText(url: string, errors: string[]): Promise<string | undefined> {
  try {
    const res = await fetch(url);
    if (!res.ok) {
      errors.push(`${url} -> ${res.status} ${res.statusText}`);
      return undefined;
    }
    return await res.text();
  } catch (err) {
    errors.push(`${url} -> network error: ${(err as Error).message}`);
    return undefined;
  }
}

function cachedJarPath(groupId: string, artifactId: string, version: string): string {
  return join(getCachePath(), "dependencies", "maven", groupId, artifactId, `${version}.jar`);
}

/**
 * Verify the downloaded jar against the registry-published checksum sidecar
 * (`<jarUrl>.sha512` / `.sha256` / `.sha1` / `.md5`, in that preference
 * order). Maven Central and most repos publish at least one of these next
 * to every artifact; a present-but-mismatching sidecar is a hard fail
 * because that's the registry telling us the bytes we got aren't the bytes
 * it intended to serve. A missing sidecar is logged at debug and tolerated
 * — some smaller mirrors (and snapshot repos for older Spigot artifacts)
 * skip them.
 */
async function verifyAgainstSidecar(
  jarUrl: string,
  bytes: Uint8Array,
  coord: string,
): Promise<void> {
  const candidates: { ext: string; algorithm: "sha512" | "sha256" | "sha1" | "md5" }[] = [
    { ext: "sha512", algorithm: "sha512" },
    { ext: "sha256", algorithm: "sha256" },
    { ext: "sha1", algorithm: "sha1" },
    { ext: "md5", algorithm: "md5" },
  ];
  for (const { ext, algorithm } of candidates) {
    const sidecarUrl = `${jarUrl}.${ext}`;
    const text = await fetchSidecarText(sidecarUrl);
    if (text === undefined) continue;
    const expected = parseSidecarHex(text);
    if (expected === undefined) continue;
    const actual = createHash(algorithm).update(bytes).digest("hex");
    if (actual !== expected) {
      throw new Error(
        `maven: ${algorithm} mismatch for "${coord}" — sidecar at ${sidecarUrl} says ${expected}, downloaded bytes hash to ${actual}. ` +
          `Refusing to use a tampered jar.`,
      );
    }
    return;
  }
  log.debug(`maven: no checksum sidecar found for ${coord} (${jarUrl})`);
}

async function fetchSidecarText(url: string): Promise<string | undefined> {
  try {
    const res = await fetch(url);
    if (!res.ok) return undefined;
    return await res.text();
  } catch {
    return undefined;
  }
}

function parseSidecarHex(text: string): string | undefined {
  // Maven sidecars are typically just `<hex>` or `<hex>  <filename>`. Tolerate
  // whitespace and extract the leading hex token.
  const trimmed = text.trim().split(/\s+/)[0]?.toLowerCase();
  if (trimmed === undefined || !/^[0-9a-f]+$/.test(trimmed)) return undefined;
  return trimmed;
}

function groupPath(groupId: string): string {
  return groupId.replace(/\./g, "/");
}

function stripTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}
