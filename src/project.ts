import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";

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
   * Hotswapping is on by default — pluggy provisions JetBrains Runtime and
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
