/**
 * Registry URL handling: scheme aliases (e.g. `github:owner/repo` →
 * `https://maven.pkg.github.com/owner/repo`) and the Maven registries
 * appended by default to every project's effective list.
 */

import { UserError } from "./errors.ts";
import type { Registry } from "./project.ts";

/** Maven registries appended to every project's declared list. */
export const DEFAULT_MAVEN_REGISTRIES: ReadonlyArray<string> = ["https://repo1.maven.org/maven2/"];

const ALIASES: Record<string, (rest: string) => string> = {
  github: (rest) => `https://maven.pkg.github.com/${rest}`,
};

/**
 * Expand a scheme alias like `github:owner/repo` into a full URL.
 *
 * An unrecognised scheme is an error rather than a passthrough. `gitlab:me/x`
 * used to survive as a literal string and surface much later as an
 * unresolvable dependency, with the registry that caused it never named.
 * `host:port` forms (digits after the colon) still pass through untouched.
 */
export function expandRegistryAlias(url: string): string {
  const colon = url.indexOf(":");
  if (colon === -1) return url;
  const scheme = url.slice(0, colon);
  if (scheme === "http" || scheme === "https") return url;
  const expander = ALIASES[scheme];
  if (expander !== undefined) return expander(url.slice(colon + 1));

  const rest = url.slice(colon + 1);
  if (/^\d/.test(rest)) return url;

  throw new UserError(`Unknown registry scheme "${scheme}:" in "${url}".`, {
    code: "E_REGISTRY_UNKNOWN_SCHEME",
    hint: `Use a full https:// URL, or one of: ${Object.keys(ALIASES)
      .map((s) => `${s}:`)
      .join(", ")}.`,
    context: { url, scheme, known: Object.keys(ALIASES) },
  });
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
