/**
 * `pluggy.lock` read / write / verify. The lockfile lives at the repo root
 * and is shared across workspaces.
 *
 * The schema is flat: every dependency, top-level or transitive, is one
 * entry in `entries`, keyed by name. An entry records what other entries
 * it directly pulls in via `transitives: string[]`. Reverse edges
 * (`pulledInBy`) are computed on demand from the forward edges.
 */

import { readFileSync } from "node:fs";
import { rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { UserError } from "./errors.ts";
import { stringifySource } from "./source.ts";
import type { ResolvedSource } from "./source.ts";

export interface LockfileEntry {
  source: ResolvedSource;
  /** Concrete version resolved by `install` (never a range). */
  resolvedVersion: string;
  /** SHA-256 of the resolved jar, as `"sha256-<base64>"`. */
  integrity: string;
  /** Workspace names that declared this dependency directly. Empty for pure transitives. */
  declaredBy: string[];
  /**
   * Names of other entries in this lockfile that this entry directly
   * pulls in. Empty or omitted for leaf deps. Resolves on-demand via
   * `entries[name]` instead of duplicating the subtree inline.
   */
  transitives?: string[];
}

export interface Lockfile {
  version: 2;
  entries: Record<string, LockfileEntry>;
}

const LOCKFILE_NAME = "pluggy.lock";

/**
 * Read `<rootDir>/pluggy.lock`. Returns `null` if missing. Throws on parse
 * or schema errors; messages always include the offending path (and entry
 * key, where applicable).
 */
export function readLock(rootDir: string): Lockfile | null {
  const path = join(rootDir, LOCKFILE_NAME);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return null;
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = (err as Error).message;
    throw new UserError(`Failed to parse lockfile at ${path}: ${msg}`, {
      code: "E_LOCKFILE_PARSE",
      hint: "Restore from version control or delete pluggy.lock and rerun pluggy install.",
      source: { file: path },
      cause: err,
    });
  }

  return validateLockfile(parsed, path);
}

/**
 * Write `<rootDir>/pluggy.lock` atomically: same-dir temp file then `rename`
 * over the target. Entries are sorted by key so diffs stay deterministic.
 * Output is 2-space-indented JSON with a trailing LF.
 */
export async function writeLock(rootDir: string, lock: Lockfile): Promise<void> {
  const path = join(rootDir, LOCKFILE_NAME);

  const sortedEntries: Record<string, LockfileEntry> = {};
  for (const key of Object.keys(lock.entries).sort()) {
    sortedEntries[key] = lock.entries[key];
  }

  const serialized = `${JSON.stringify({ version: lock.version, entries: sortedEntries }, null, 2)}\n`;

  // Same-dir temp guarantees rename is same-filesystem; pid+random avoids collisions.
  const tempName = `${LOCKFILE_NAME}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  const tempPath = join(rootDir, tempName);

  try {
    await writeFile(tempPath, serialized, "utf8");
    await rename(tempPath, path);
  } catch (err) {
    try {
      await unlink(tempPath);
    } catch {
      // Temp may not exist (writeFile itself failed).
    }
    throw err;
  }
}

/**
 * Return dependency names that are missing from the lock or stale against
 * what's declared. Empty means the lockfile is fresh.
 *
 * "Stale" means the lockfile entry exists but its source string or version
 * diverges from the declaration. Orphaned entries (locked but not declared)
 * are ignored. Does not refetch or recompute integrity. The resolver does
 * that.
 */
export function verifyLock(
  lock: Lockfile,
  declared: Record<string, { source: ResolvedSource }>,
): string[] {
  const drift: string[] = [];
  for (const name of Object.keys(declared)) {
    const declaredSource = declared[name].source;
    const entry = lock.entries[name];
    if (entry === undefined) {
      drift.push(name);
      continue;
    }
    if (
      stringifySource(entry.source) !== stringifySource(declaredSource) ||
      entry.source.version !== declaredSource.version
    ) {
      drift.push(name);
    }
  }
  return drift;
}

/**
 * Drop entries that are neither top-level (declared by some workspace)
 * nor reachable from a top-level entry's `transitives` graph. Mutates
 * `entries` in place. Iterates until a steady state in case removals
 * expose new orphans (a transitive whose only parent was itself orphaned).
 *
 * Callers that already know the top-level set can pass it as `topLevel`;
 * by default it's derived from `entry.declaredBy.length > 0`, which is
 * the lockfile's own source of truth.
 */
export function pruneOrphans(entries: Record<string, LockfileEntry>, topLevel?: Set<string>): void {
  const tops = topLevel ?? deriveTopLevel(entries);
  for (;;) {
    const reachable = new Set<string>();
    const stack: string[] = [];
    for (const name of tops) {
      if (entries[name] !== undefined) {
        reachable.add(name);
        stack.push(name);
      }
    }
    while (stack.length > 0) {
      const name = stack.pop() as string;
      const entry = entries[name];
      if (entry === undefined) continue;
      for (const child of entry.transitives ?? []) {
        if (!reachable.has(child) && entries[child] !== undefined) {
          reachable.add(child);
          stack.push(child);
        }
      }
    }
    let removed = false;
    for (const key of Object.keys(entries)) {
      if (!reachable.has(key)) {
        delete entries[key];
        removed = true;
      }
    }
    if (!removed) return;
  }
}

function deriveTopLevel(entries: Record<string, LockfileEntry>): Set<string> {
  const out = new Set<string>();
  for (const [name, entry] of Object.entries(entries)) {
    if (entry.declaredBy.length > 0) out.add(name);
  }
  return out;
}

/**
 * Build a reverse-edge index: for each entry, the names of entries that
 * directly pull it in via their `transitives`. Top-level-only deps
 * (declared by a workspace, never pulled in transitively) map to `[]`.
 */
export function pulledInBy(lock: Lockfile): Record<string, string[]> {
  const reverse: Record<string, string[]> = {};
  for (const name of Object.keys(lock.entries)) reverse[name] = [];
  for (const [name, entry] of Object.entries(lock.entries)) {
    for (const child of entry.transitives ?? []) {
      if (reverse[child] === undefined) reverse[child] = [];
      reverse[child].push(name);
    }
  }
  return reverse;
}

function validateLockfile(parsed: unknown, path: string): Lockfile {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new UserError(`Invalid lockfile at ${path}: expected a JSON object`, {
      code: "E_LOCKFILE_INVALID",
      hint: "Delete pluggy.lock and rerun pluggy install to regenerate it.",
      source: { file: path },
    });
  }
  const obj = parsed as Record<string, unknown>;

  if (obj.version !== 2) {
    throw new UserError(
      `Unsupported lockfile version: ${String(obj.version)} (at ${path}; expected 2)`,
      {
        code: "E_LOCKFILE_VERSION",
        hint: "Delete pluggy.lock and rerun pluggy install to regenerate it under the current version.",
        source: { file: path, pointer: "/version" },
      },
    );
  }

  if (obj.entries === null || typeof obj.entries !== "object" || Array.isArray(obj.entries)) {
    throw new UserError(`Invalid lockfile at ${path}: "entries" must be an object`, {
      code: "E_LOCKFILE_INVALID",
      hint: "Delete pluggy.lock and rerun pluggy install to regenerate it.",
      source: { file: path, pointer: "/entries" },
    });
  }
  const rawEntries = obj.entries as Record<string, unknown>;

  const entries: Record<string, LockfileEntry> = {};
  for (const key of Object.keys(rawEntries)) {
    entries[key] = validateEntry(rawEntries[key], key, path);
  }

  return { version: 2, entries };
}

function validateEntry(raw: unknown, key: string, path: string): LockfileEntry {
  const entryHint = "Delete pluggy.lock and rerun pluggy install to regenerate it.";
  const entryPointer = `/entries/${key}`;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new UserError(`Invalid lockfile entry "${key}" at ${path}: expected an object`, {
      code: "E_LOCKFILE_INVALID_ENTRY",
      hint: entryHint,
      source: { file: path, pointer: entryPointer },
    });
  }
  const entry = raw as Record<string, unknown>;

  if (entry.source === undefined) {
    throw new UserError(`Invalid lockfile entry "${key}" at ${path}: missing "source"`, {
      code: "E_LOCKFILE_INVALID_ENTRY",
      hint: entryHint,
      source: { file: path, pointer: `${entryPointer}/source` },
    });
  }
  if (typeof entry.resolvedVersion !== "string") {
    throw new UserError(
      `Invalid lockfile entry "${key}" at ${path}: "resolvedVersion" must be a string`,
      {
        code: "E_LOCKFILE_INVALID_ENTRY",
        hint: entryHint,
        source: { file: path, pointer: `${entryPointer}/resolvedVersion` },
      },
    );
  }
  if (typeof entry.integrity !== "string") {
    throw new UserError(
      `Invalid lockfile entry "${key}" at ${path}: "integrity" must be a string`,
      {
        code: "E_LOCKFILE_INVALID_ENTRY",
        hint: entryHint,
        source: { file: path, pointer: `${entryPointer}/integrity` },
      },
    );
  }
  if (!Array.isArray(entry.declaredBy) || !entry.declaredBy.every((d) => typeof d === "string")) {
    throw new UserError(
      `Invalid lockfile entry "${key}" at ${path}: "declaredBy" must be an array of strings`,
      {
        code: "E_LOCKFILE_INVALID_ENTRY",
        hint: entryHint,
        source: { file: path, pointer: `${entryPointer}/declaredBy` },
      },
    );
  }

  const source = validateResolvedSource(entry.source, key, path);

  const result: LockfileEntry = {
    source,
    resolvedVersion: entry.resolvedVersion,
    integrity: entry.integrity,
    declaredBy: entry.declaredBy as string[],
  };

  if (entry.transitives !== undefined) {
    if (
      !Array.isArray(entry.transitives) ||
      !entry.transitives.every((t) => typeof t === "string")
    ) {
      throw new UserError(
        `Invalid lockfile entry "${key}" at ${path}: "transitives" must be an array of strings`,
        {
          code: "E_LOCKFILE_INVALID_ENTRY",
          hint: entryHint,
          source: { file: path, pointer: `${entryPointer}/transitives` },
        },
      );
    }
    if (entry.transitives.length > 0) {
      result.transitives = entry.transitives as string[];
    }
  }

  return result;
}

/**
 * Validate an arbitrary `unknown` against the `ResolvedSource` tagged union.
 * Centralized so the on-disk form stays in lock-step with `src/source.ts`.
 */
function validateResolvedSource(raw: unknown, key: string, path: string): ResolvedSource {
  const sourceHint = "Delete pluggy.lock and rerun pluggy install to regenerate it.";
  const sourcePointer = `/entries/${key}/source`;
  const fail = (message: string, pointer = sourcePointer): never => {
    throw new UserError(message, {
      code: "E_LOCKFILE_INVALID_SOURCE",
      hint: sourceHint,
      source: { file: path, pointer },
    });
  };

  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    fail(`Invalid lockfile entry "${key}" at ${path}: "source" must be an object`);
  }
  const src = raw as Record<string, unknown>;
  if (typeof src.version !== "string" || src.version.length === 0) {
    fail(
      `Invalid lockfile entry "${key}" at ${path}: "source.version" must be a non-empty string`,
      `${sourcePointer}/version`,
    );
  }

  switch (src.kind) {
    case "modrinth": {
      if (typeof src.slug !== "string" || src.slug.length === 0) {
        fail(
          `Invalid lockfile entry "${key}" at ${path}: modrinth source requires a non-empty "slug"`,
          `${sourcePointer}/slug`,
        );
      }
      return { kind: "modrinth", slug: src.slug as string, version: src.version as string };
    }
    case "maven": {
      if (typeof src.groupId !== "string" || src.groupId.length === 0) {
        fail(
          `Invalid lockfile entry "${key}" at ${path}: maven source requires a non-empty "groupId"`,
          `${sourcePointer}/groupId`,
        );
      }
      if (typeof src.artifactId !== "string" || src.artifactId.length === 0) {
        fail(
          `Invalid lockfile entry "${key}" at ${path}: maven source requires a non-empty "artifactId"`,
          `${sourcePointer}/artifactId`,
        );
      }
      return {
        kind: "maven",
        groupId: src.groupId as string,
        artifactId: src.artifactId as string,
        version: src.version as string,
      };
    }
    case "file": {
      if (typeof src.path !== "string" || src.path.length === 0) {
        fail(
          `Invalid lockfile entry "${key}" at ${path}: file source requires a non-empty "path"`,
          `${sourcePointer}/path`,
        );
      }
      return { kind: "file", path: src.path as string, version: src.version as string };
    }
    case "workspace": {
      if (typeof src.name !== "string" || src.name.length === 0) {
        fail(
          `Invalid lockfile entry "${key}" at ${path}: workspace source requires a non-empty "name"`,
          `${sourcePointer}/name`,
        );
      }
      return { kind: "workspace", name: src.name as string, version: src.version as string };
    }
    default:
      throw new UserError(
        `Invalid lockfile entry "${key}" at ${path}: unknown source kind "${String(src.kind)}" (expected "modrinth", "maven", "file", or "workspace")`,
        {
          code: "E_LOCKFILE_INVALID_SOURCE",
          hint: 'Known source kinds: "modrinth", "maven", "file", "workspace".',
          source: { file: path, pointer: `${sourcePointer}/kind` },
        },
      );
  }
}
