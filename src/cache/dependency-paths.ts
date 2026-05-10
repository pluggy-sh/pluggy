import { join } from "node:path";

import type { LockfileEntry } from "../lockfile.ts";
import { getCachePath } from "../project.ts";

// `+` is load-bearing for real-world Modrinth/Maven versions (e.g.
// `1.20.1+forge`).
const SAFE_NAME_RE = /^[A-Za-z0-9._+~-]+$/;

/**
 * Path to the cached jar for a lockfile entry, or `undefined` for
 * `workspace:` sources (which build locally instead of being cached).
 *
 * Every path component from the lockfile is run through `assertSafeName`
 * so a crafted lockfile can't construct a path that escapes the cache
 * root.
 */
export function cachedJarPathForEntry(entry: LockfileEntry): string | undefined {
  const base = join(getCachePath(), "dependencies");
  const src = entry.source;
  switch (src.kind) {
    case "modrinth":
      assertSafeName(src.slug, "source.slug");
      assertSafeName(entry.resolvedVersion, "resolvedVersion");
      return join(base, "modrinth", src.slug, `${entry.resolvedVersion}.jar`);
    case "maven":
      assertSafeName(src.groupId, "source.groupId");
      assertSafeName(src.artifactId, "source.artifactId");
      assertSafeName(entry.resolvedVersion, "resolvedVersion");
      return join(base, "maven", src.groupId, src.artifactId, `${entry.resolvedVersion}.jar`);
    case "file": {
      // The file-resolver cache key is `sha256-<hex>.jar`; lockfile integrity is
      // `sha256-<hex>`; strip the prefix.
      const hex = entry.integrity.startsWith("sha256-")
        ? entry.integrity.slice("sha256-".length)
        : entry.integrity;
      assertSafeName(hex, "integrity");
      return join(base, "file", `${hex}.jar`);
    }
    case "workspace":
      return undefined;
  }
}

export function assertSafeName(value: string, field: string): void {
  if (typeof value !== "string" || value.length === 0 || !SAFE_NAME_RE.test(value)) {
    throw new Error(
      `Refusing unsafe lockfile ${field} ${JSON.stringify(value)}: won't construct a cache path that could escape the cache root`,
    );
  }
  if (value === "." || value === "..") {
    throw new Error(
      `Refusing reserved lockfile ${field} ${JSON.stringify(value)}: would traverse the cache root`,
    );
  }
}
