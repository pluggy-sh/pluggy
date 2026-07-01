import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";

import { UserError } from "./errors.ts";
import { writeFileLF } from "./portable.ts";

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
  /**
   * Plugin commands, keyed by command name. Rendered into the Bukkit-family
   * descriptor's `commands:` block (paper/spigot/folia); other platforms
   * register commands in code and ignore this. The plugin still implements
   * the behaviour in `onCommand`/an executor — this only registers the name
   * with the server so it routes to the plugin.
   */
  commands?: Record<string, CommandSpec>;
  resources?: Record<string, string>;
  workspaces?: string[];
  dev?: DevConfig;
  /**
   * Opt out of `pluggy docs` for this workspace. The command at the repo
   * root silently skips workspaces with `docs: false`; an explicit
   * `--workspace <name>` still documents it. Ignored by lockfile-wide
   * commands (`why`, `outdated`, `audit`). Defaults to `true`.
   */
  docs?: boolean;
  /**
   * Opt out of `pluggy test` for this workspace. Same semantics as `docs`:
   * sweeps skip; explicit `--workspace <name>` still runs. Defaults to
   * `true`.
   */
  test?: boolean;
  /**
   * Named shell tasks invokable via `pluggy run <name>`. Values follow the
   * `cmd arg arg` shape; pluggy never spawns through a shell, so complex
   * pipelines belong in a script file (`./scripts/check.sh`) referenced by
   * one of these entries. `${project.x}` / `${workspace.x}` substitution
   * runs before tokenization.
   *
   * Scripts cascade additively from the root. A workspace can override a
   * root-defined script (later wins on collision) or opt out by setting the
   * value to `null` (parsed at the schema boundary; downstream consumers
   * never see `null`).
   */
  scripts?: Record<string, string>;
  /**
   * Optional JDK pin. When omitted, pluggy derives the required major from
   * `compatibility.versions[0]` and downloads the default distribution
   * (Temurin) on demand. Pinning here travels with the repo so teammates
   * land on the same JDK.
   */
  jdk?: JdkConfig;
}

export interface JdkConfig {
  /** Java major release, e.g. 21. When omitted, derived from MC version. */
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

/**
 * A Bukkit plugin command. Mirrors the `commands:` entries in `plugin.yml`
 * (https://docs.papermc.io/paper/dev/plugin-yml#commands): every field is
 * optional and only emitted when set.
 */
export interface CommandSpec {
  /** Short help text shown by the server's help system. */
  description?: string;
  /** Usage string, e.g. `/<command> <player>`. */
  usage?: string;
  /** Alternate names that also route to this command. */
  aliases?: string[];
  /** Permission node required to run it. */
  permission?: string;
  /** Message shown when the sender lacks `permission`. */
  permissionMessage?: string;
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
  /** Hotswap changed classes in place on rebuild. Default on; `false` disables it. */
  hotswap?: boolean;
  /**
   * What to do when a change can't be hotswapped. Default `"manual"` (notify
   * and wait for you to type `restart`), or `"restart"` when hotswap is off.
   * `"reload"` uses the deprecated `/reload` command.
   */
  fallback?: "manual" | "reload" | "restart";
  /**
   * Attach a JDWP debug agent so an IDE can set breakpoints. `true` uses the
   * default port 5005; a number sets the port; an object configures port and
   * suspend. Off by default; also toggled per-run with `--debug`.
   */
  debug?: boolean | number | DebugConfig;
}

export interface DebugConfig {
  /** JDWP listen port. Default 5005. */
  port?: number;
  /**
   * When `true`, the JVM waits for a debugger to attach before starting — use
   * it to break in `onEnable`. Default `false`.
   */
  suspend?: boolean;
  /**
   * When `true`, bind the JDWP agent to all interfaces (`*`) instead of
   * loopback. JDWP is unauthenticated, so this exposes remote code execution
   * to the whole network — only enable it when the debugger runs on another
   * host (a container or WSL2). Default `false`.
   */
  exposed?: boolean;
}

/**
 * OS-appropriate user cache directory for pluggy.
 *
 * macOS: `~/Library/Caches/pluggy`.
 * Windows: `%LOCALAPPDATA%/pluggy/cache`.
 * Linux/other: `$XDG_CACHE_HOME/pluggy` (defaulting to `~/.cache/pluggy`).
 *
 * Cache contents are *reproducible*: wiping this directory only forces
 * re-downloads. State that must survive `pluggy cache clean` (e.g.
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
 * cache: state is small, non-regenerable metadata (e.g. the cached
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

/**
 * Serialize and persist a `project.json`. Strips `ResolvedProject`-only fields
 * (`rootDir`, `projectFile`) so they don't leak into the file. Two-space JSON
 * indent and a trailing newline, written with LF endings via `writeFileLF`.
 *
 * Use this anywhere we mutate an existing `project.json` (e.g. `install`,
 * `workspace add`) so indent, line endings, and field ordering stay
 * consistent across commands.
 */
export async function writeProjectFile(path: string, project: Project): Promise<void> {
  const { rootDir: _rootDir, projectFile: _projectFile, ...rest } = project as ResolvedProject;
  await writeFileLF(path, `${JSON.stringify(rest, null, 2)}\n`);
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
    const projectFile = (project as Partial<ResolvedProject>).projectFile;
    throw new UserError(
      `project "${project.name}" has no compatibility.platforms. Declare at least one platform.`,
      {
        code: "E_PROJECT_NO_PLATFORMS",
        hint: 'Add at least one platform to "compatibility.platforms" in project.json.',
        source:
          projectFile !== undefined
            ? { file: projectFile, pointer: "/compatibility/platforms" }
            : undefined,
      },
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
    const projectFile = (project as Partial<ResolvedProject>).projectFile;
    throw new UserError(
      `project "${project.name}" has no compatibility.versions. Declare at least one Minecraft version.`,
      {
        code: "E_PROJECT_NO_VERSIONS",
        hint: 'Add at least one Minecraft version to "compatibility.versions" in project.json.',
        source:
          projectFile !== undefined
            ? { file: projectFile, pointer: "/compatibility/versions" }
            : undefined,
      },
    );
  }
  return list[0];
}
