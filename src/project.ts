import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";

import { UserError } from "./errors.ts";

/** Parsed `project.json`. */
export interface Project {
  name: string;
  version: string;
  description?: string;
  authors?: string[];
  /** Fully-qualified main class. Required for plugin workspaces; not on a root that declares `workspaces`. */
  main?: string;
  compatibility: {
    versions: string[];
    platforms: string[];
  };
  dependencies?: Record<string, string | Dependency>;
  testDependencies?: Record<string, string | Dependency>;
  registries?: (string | Registry)[];
  shading?: Record<string, Shading>;
  resources?: Record<string, string>;
  workspaces?: string[];
  dev?: DevConfig;
  /**
   * Optional JDK pin. When omitted, pluggy derives the required major from
   * `compatibility.versions[0]` and downloads the default distribution
   * (Temurin) on demand. Pinning here travels with the repo so teammates
   * land on the same JDK.
   */
  jdk?: JdkConfig;
}

export interface JdkConfig {
  /** Java major release, for example 21. When omitted, derived from MC version. */
  major?: number;
  /** Disco distribution slug. Default `"temurin"`. */
  distribution?: string;
}

/** Project augmented with its resolved on-disk location. */
export type ResolvedProject = Project & {
  rootDir: string;
  projectFile: string;
};

export interface Dependency {
  source: string;
  version: string;
}

export interface Shading {
  exclude?: string[];
  include?: string[];
}

export interface Registry {
  url: string;
  credentials?: {
    username: string;
    password: string;
  };
}

export interface DevConfig {
  port?: number;
  memory?: string;
  onlineMode?: boolean;
  jvmArgs?: string[];
  serverProperties?: Record<string, string | number | boolean>;
  extraPlugins?: string[];
  /**
   * Hotswapping is on by default. Pluggy provisions JetBrains Runtime and
   * HotswapAgent into the user cache and reloads classes in-place on every
   * rebuild. Set to `false` to fall back to plain restart-on-change.
   */
  hotswap?: boolean | HotswapConfig;
}

export interface HotswapConfig {
  /** `"jbr"` (default) downloads JetBrains Runtime; `"system"` uses `java` from PATH. */
  jdk?: "jbr" | "system";
  /** Action when a class change can't be hotswapped. Defaults to `"reload"`. */
  fallback?: "reload" | "restart";
}

/**
 * OS-appropriate user cache directory for pluggy.
 *
 * macOS: `~/Library/Caches/pluggy`.
 * Windows: `%LOCALAPPDATA%/pluggy/cache`.
 * Linux/other: `$XDG_CACHE_HOME/pluggy` (defaulting to `~/.cache/pluggy`).
 *
 * Cache contents are *reproducible*: wiping this directory only forces
 * re-downloads. State that must survive `pluggy cache clean` (for example,
 * the update-check timestamp) belongs under `getStatePath` instead.
 */
export function getCachePath(): string {
  const home = homedir();
  if (process.platform === "darwin") {
    return join(home, "Library", "Caches", "pluggy");
  }
  if (process.platform === "win32") {
    return join(process.env.LOCALAPPDATA || join(home, "AppData", "Local"), "pluggy", "cache");
  }
  return join(process.env.XDG_CACHE_HOME || join(home, ".cache"), "pluggy");
}

/**
 * OS-appropriate user *state* directory for pluggy. Distinct from the
 * cache: state is small, non-regenerable metadata (for example, the cached
 * latest-release tag from the update checker) that must survive
 * `pluggy cache clean`.
 *
 * macOS: `~/Library/Application Support/pluggy`.
 * Windows: `%APPDATA%/pluggy`.
 * Linux/other: `$XDG_STATE_HOME/pluggy` (defaulting to `~/.local/state/pluggy`).
 */
export function getStatePath(): string {
  const home = homedir();
  if (process.platform === "darwin") {
    return join(home, "Library", "Application Support", "pluggy");
  }
  if (process.platform === "win32") {
    return join(process.env.APPDATA || join(home, "AppData", "Roaming"), "pluggy");
  }
  return join(process.env.XDG_STATE_HOME || join(home, ".local", "state"), "pluggy");
}

const PROJECT_FILE_NAME = "project.json";

/**
 * Walk up from `path` until a `project.json` is found, returning the parsed
 * project plus its resolved location. Returns `undefined` if no project is
 * found on the way up to the filesystem root.
 */
export function resolveProject(path: string): ResolvedProject | undefined {
  let currentPath = path;
  while (currentPath !== dirname(currentPath)) {
    const projectFilePath = join(currentPath, PROJECT_FILE_NAME);
    if (existsSync(projectFilePath)) {
      const projectFileContent = readFileSync(projectFilePath, "utf8");
      const project: ResolvedProject = JSON.parse(projectFileContent);
      project.rootDir = dirname(projectFilePath);
      project.projectFile = projectFilePath;
      return project;
    }
    currentPath = dirname(currentPath);
  }
  return undefined;
}

/** Read a specific `project.json` by path. Returns `undefined` if missing. */
export function resolveProjectFile(path: string): ResolvedProject | undefined {
  if (existsSync(path)) {
    const projectFileContent = readFileSync(path, "utf8");
    const project: ResolvedProject = JSON.parse(projectFileContent);
    project.projectFile = path;
    return project;
  }
  return undefined;
}

/** `resolveProject` starting from `cwd` (or `process.cwd()` by default). */
export function getCurrentProject(cwd?: string): ResolvedProject | undefined {
  const path = cwd || process.cwd();
  return resolveProject(path);
}

/**
 * Primary platform for a project. Plugin commands that act on a single
 * platform (`dev`, `build`'s main jar) use this; the rest of
 * `compatibility.platforms` are extra compile-check targets.
 *
 * Throws `UserError` when `compatibility.platforms` is empty or missing.
 * The schema doesn't enforce non-empty; this helper is the single
 * runtime gate.
 */
export function primaryPlatform(project: Project): string {
  const list = project.compatibility?.platforms ?? [];
  if (list.length === 0) {
    throw new UserError(
      `project "${project.name}" has no compatibility.platforms. Declare at least one platform.`,
    );
  }
  return list[0];
}

/**
 * Primary Minecraft version for a project. Used wherever pluggy needs a
 * single MC version (dev server boot, BuildTools invocation, JDK
 * targeting). Other entries in `compatibility.versions` are the supported
 * range; index 0 is canonical.
 *
 * Throws `UserError` when `compatibility.versions` is empty or missing.
 */
export function primaryVersion(project: Project): string {
  const list = project.compatibility?.versions ?? [];
  if (list.length === 0) {
    throw new UserError(
      `project "${project.name}" has no compatibility.versions. Declare at least one Minecraft version.`,
    );
  }
  return list[0];
}
