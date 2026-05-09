/**
 * Registry URL handling: scheme aliases (for example, `github:owner/repo` →
 * `https://maven.pkg.github.com/owner/repo`) and the Maven registries
 * appended by default to every project's effective list.
 */

import type { Registry } from "./project.ts";

/** Maven registries appended to every project's declared list. */
export const DEFAULT_MAVEN_REGISTRIES: ReadonlyArray<string> = ["https://repo1.maven.org/maven2/"];

const ALIASES: Record<string, (rest: string) => string> = {
  github: (rest) => `https://maven.pkg.github.com/${rest}`,
};

/**
 * Expand a scheme alias like `github:owner/repo` into a full URL. Bare
 * `http(s)://…` URLs and unknown schemes pass through unchanged.
 */
export function expandRegistryAlias(url: string): string {
  const colon = url.indexOf(":");
  if (colon === -1) return url;
  const scheme = url.slice(0, colon);
  if (scheme === "http" || scheme === "https") return url;
  const expander = ALIASES[scheme];
  if (expander === undefined) return url;
  return expander(url.slice(colon + 1));
}

/** Pull the URL out of a Registry entry, expanding any alias. */
export function registryUrl(entry: string | Registry): string {
  return expandRegistryAlias(typeof entry === "string" ? entry : entry.url);
}

/** Dedupe a URL list, treating trailing-slash variants as the same entry. */
export function dedupeRegistryUrls(urls: ReadonlyArray<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const u of urls) {
    const key = u.endsWith("/") ? u.slice(0, -1) : u;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(u);
  }
  return out;
}

/**
 * Final URL list the resolver should walk: declared entries (with aliases
 * expanded) followed by `DEFAULT_MAVEN_REGISTRIES`, deduped.
 */
export function effectiveRegistries(
  declared: ReadonlyArray<string | Registry> | undefined,
): string[] {
  const urls: string[] = [];
  for (const entry of declared ?? []) urls.push(registryUrl(entry));
  return dedupeRegistryUrls([...urls, ...DEFAULT_MAVEN_REGISTRIES]);
}
