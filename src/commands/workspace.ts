/**
 * `pluggy workspace`: parent command for workspace-graph mutations. Today
 * `add <name>` is the only subcommand; `remove` / `rename` etc. are natural
 * follow-ups but live on a single nounish surface from day one.
 *
 * `add <name>` flow:
 *   1. Validate `<name>` (POSIX-safe; no path traversal; no collision with
 *      an existing declared workspace).
 *   2. Pick the on-disk directory (defaults to `./<name>`).
 *   3. Write the child `project.json` (via `writeProjectFile`).
 *   4. Update the root's `workspaces` array (via `writeProjectFile`).
 *
 * Step order matters: child first. A crash between (3) and (4) leaves an
 * unreferenced folder that `enumerateWorkspaces` ignores; the inverse would
 * leave a dangling entry that hard-fails the next workspace command.
 */

import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import process from "node:process";

import { Command, InvalidArgumentError } from "commander";

import { UserError } from "../errors.ts";
import { bold, dim, emit, log } from "../logging.ts";
import { toPosixPath, writeFileLF } from "../portable.ts";
import { type Dependency, type Project, resolveProjectFile, writeProjectFile } from "../project.ts";

export interface WorkspaceAddOptions {
  name: string;
  /** FQCN of the new workspace's `main` class. Omit for an internal workspace. */
  main?: string;
  /**
   * Platforms for the new workspace's `compatibility.platforms`. Empty means
   * inherit from the root.
   */
  platforms?: string[];
  /**
   * Names of existing workspaces this new one should depend on (wired as
   * `workspace:<name>` deps with version `"*"`).
   */
  depends?: string[];
  /** Override the on-disk directory. Defaults to `./<name>` relative to the root. */
  dir?: string;
  /** Initial version for the workspace's `project.json`. Defaults to `0.1.0`. */
  version?: string;
  cwd?: string;
}

export interface WorkspaceAddResult {
  status: "success";
  exitCode: 0;
  name: string;
  workspaceDir: string;
  projectFile: string;
  rootProjectFile: string;
}

const VALID_NAME_RE = /^[A-Za-z][A-Za-z0-9._-]*$/;

export async function runWorkspaceAdd(opts: WorkspaceAddOptions): Promise<WorkspaceAddResult> {
  if (!VALID_NAME_RE.test(opts.name)) {
    throw new InvalidArgumentError(
      `workspace name "${opts.name}" is invalid: must start with a letter and contain only letters, digits, ".", "_", or "-".`,
    );
  }

  const cwd = opts.cwd ?? process.cwd();
  const rootProjectFile = locateRootProjectFile(cwd);
  const root = resolveProjectFile(rootProjectFile);
  if (root === undefined) {
    throw new Error(`failed to read root project at ${rootProjectFile}`);
  }
  const rootDir = dirname(rootProjectFile);

  const existing = root.workspaces ?? [];
  for (const rel of existing) {
    const wsDir = resolveWorkspacePath(rootDir, rel);
    const wsProjectFile = join(wsDir, "project.json");
    const wsProject = resolveProjectFile(wsProjectFile);
    if (wsProject?.name === opts.name) {
      throw new UserError(`workspace "${opts.name}" already declared at ${rel}`, {
        code: "E_WORKSPACE_NAME_COLLISION",
        hint: "Pick a different --name, or remove the existing workspace first.",
        context: { existing: rel },
      });
    }
  }

  const relDir = sanitizeRelDir(opts.dir ?? `./${opts.name}`);
  const workspaceDir = resolve(rootDir, relDir);
  if (!isUnderRoot(rootDir, workspaceDir)) {
    throw new InvalidArgumentError(`--dir "${opts.dir}" escapes the project root.`);
  }
  if (await pathExists(workspaceDir)) {
    throw new InvalidArgumentError(
      `directory "${relDir}" already exists; refusing to overwrite. Pick a different --dir.`,
    );
  }

  // Build the new workspace's project.json.
  const newProject: Project = {
    name: opts.name,
    version: opts.version ?? "0.1.0",
    compatibility:
      opts.platforms !== undefined && opts.platforms.length > 0
        ? {
            versions: root.compatibility?.versions ?? [],
            platforms: opts.platforms,
          }
        : (undefined as unknown as Project["compatibility"]),
  };
  if (opts.main !== undefined && opts.main.length > 0) {
    newProject.main = opts.main;
  }
  if (opts.depends !== undefined && opts.depends.length > 0) {
    const deps: Record<string, Dependency> = {};
    for (const depName of opts.depends) {
      deps[depName] = { source: `workspace:${depName}`, version: "*" };
    }
    newProject.dependencies = deps;
  }
  // If compatibility is not set explicitly, omit it entirely so inheritance
  // picks up the root's value. The `(undefined as ...)` cast above was a
  // placeholder; clean it up here.
  if ((newProject.compatibility as unknown) === undefined || newProject.compatibility === null) {
    delete (newProject as Partial<Project>).compatibility;
  }

  // Step 1: write the child project.json (its directory, then file).
  await mkdir(workspaceDir, { recursive: true });
  const newProjectFile = join(workspaceDir, "project.json");
  await writeProjectFile(newProjectFile, newProject);

  // If a main class was given, scaffold a minimal Java source file.
  if (typeof newProject.main === "string" && newProject.main.length > 0) {
    await scaffoldMain(workspaceDir, newProject.main);
  }

  // Step 2: update root's `workspaces` array. Stored as relative POSIX path.
  const wsRelPath = `./${toPosixPath(relative(rootDir, workspaceDir))}`;
  const rootRaw: Project = {
    ...stripResolved(root),
    workspaces: dedupePreserving([...(root.workspaces ?? []), wsRelPath]),
  };
  await writeProjectFile(rootProjectFile, rootRaw);

  const result: WorkspaceAddResult = {
    status: "success",
    exitCode: 0,
    name: opts.name,
    workspaceDir,
    projectFile: newProjectFile,
    rootProjectFile,
  };
  emit(result as unknown as Record<string, unknown>, () => {
    log.heading(`Added workspace ${bold(opts.name)}`);
    log.step(`${dim("→")} ${newProjectFile}`);
    log.step(`${dim("→")} updated ${rootProjectFile}`);
  });
  return result;
}

function stripResolved(project: Project & { rootDir?: string; projectFile?: string }): Project {
  const { rootDir: _r, projectFile: _p, ...rest } = project;
  return rest;
}

function dedupePreserving(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

function locateRootProjectFile(cwd: string): string {
  let current = resolve(cwd);
  while (true) {
    const candidate = join(current, "project.json");
    const parsed = resolveProjectFile(candidate);
    if (parsed !== undefined) {
      // Walk up one more level to see if a parent declares this folder as a
      // workspace — in that case the parent is the root.
      const parentDir = dirname(current);
      if (parentDir !== current) {
        const parentFile = join(parentDir, "project.json");
        const parent = resolveProjectFile(parentFile);
        if (
          parent !== undefined &&
          Array.isArray(parent.workspaces) &&
          parent.workspaces.some((rel) => resolveWorkspacePath(parentDir, rel) === current)
        ) {
          return parentFile;
        }
      }
      return candidate;
    }
    const next = dirname(current);
    if (next === current) {
      throw new UserError(`no pluggy project found at or above ${cwd}`, {
        code: "E_NO_PROJECT",
        hint: "Run `pluggy init` to create one first.",
      });
    }
    current = next;
  }
}

function resolveWorkspacePath(root: string, rel: string): string {
  const normalized = rel.replace(/\\/g, "/");
  if (isAbsolute(normalized)) return resolve(normalized);
  return resolve(root, normalized);
}

function sanitizeRelDir(input: string): string {
  const normalized = input.replace(/\\/g, "/");
  return normalized.startsWith("./") || isAbsolute(normalized) ? normalized : `./${normalized}`;
}

function isUnderRoot(rootDir: string, target: string): boolean {
  const rel = relative(rootDir, target);
  return !rel.startsWith("..") && !isAbsolute(rel);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function scaffoldMain(workspaceDir: string, mainClass: string): Promise<void> {
  const dotIdx = mainClass.lastIndexOf(".");
  if (dotIdx === -1) return; // no package; skip the stub
  const pkg = mainClass.slice(0, dotIdx);
  const cls = mainClass.slice(dotIdx + 1);
  const srcDir = join(workspaceDir, "src", ...pkg.split("."));
  await mkdir(srcDir, { recursive: true });
  const javaFile = join(srcDir, `${cls}.java`);
  await writeFileLF(javaFile, `package ${pkg};\n\npublic class ${cls} {\n}\n`);
}

/** Suppress unused-import warning for writeFile (kept for future scaffolding). */
const _unusedWriteFile = writeFile;
void _unusedWriteFile;

export interface WorkspaceRemoveOptions {
  name: string;
  /** Also delete the workspace's directory and contents. Default: leave files. */
  deleteFiles?: boolean;
  /** Remove even if other workspaces declare a `workspace:<name>` dep. */
  force?: boolean;
  cwd?: string;
}

export interface WorkspaceRemoveResult {
  status: "success";
  exitCode: 0;
  name: string;
  workspaceDir: string;
  rootProjectFile: string;
  deletedFiles: boolean;
}

export async function runWorkspaceRemove(
  opts: WorkspaceRemoveOptions,
): Promise<WorkspaceRemoveResult> {
  const cwd = opts.cwd ?? process.cwd();
  const rootProjectFile = locateRootProjectFile(cwd);
  const root = resolveProjectFile(rootProjectFile);
  if (root === undefined) {
    throw new Error(`failed to read root project at ${rootProjectFile}`);
  }
  const rootDir = dirname(rootProjectFile);

  const declared = root.workspaces ?? [];
  let matchedRel: string | undefined;
  let matchedDir: string | undefined;
  for (const rel of declared) {
    const wsDir = resolveWorkspacePath(rootDir, rel);
    const wsProjectFile = join(wsDir, "project.json");
    const wsProject = resolveProjectFile(wsProjectFile);
    if (wsProject?.name === opts.name) {
      matchedRel = rel;
      matchedDir = wsDir;
      break;
    }
  }
  if (matchedRel === undefined || matchedDir === undefined) {
    const known = declared.map((rel) => {
      const wsProject = resolveProjectFile(
        join(resolveWorkspacePath(rootDir, rel), "project.json"),
      );
      return wsProject?.name ?? rel;
    });
    throw new UserError(`workspace "${opts.name}" is not declared in the root project`, {
      code: "E_WORKSPACE_NOT_FOUND",
      hint: known.length > 0 ? `Known workspaces: ${known.join(", ")}` : undefined,
      context: { known },
    });
  }

  // Refuse if any other workspace lists this one as a `workspace:` dep
  // (unless --force). The build would break the moment they ran it.
  if (opts.force !== true) {
    const dependents: string[] = [];
    for (const rel of declared) {
      if (rel === matchedRel) continue;
      const wsProject = resolveProjectFile(
        join(resolveWorkspacePath(rootDir, rel), "project.json"),
      );
      if (wsProject === undefined) continue;
      for (const [, raw] of Object.entries(wsProject.dependencies ?? {})) {
        if (typeof raw === "string") continue;
        if (raw.source === `workspace:${opts.name}`) {
          dependents.push(wsProject.name);
          break;
        }
      }
    }
    if (dependents.length > 0) {
      throw new UserError(
        `cannot remove "${opts.name}": workspaces ${dependents.map((n) => `"${n}"`).join(", ")} depend on it`,
        {
          code: "E_WORKSPACE_HAS_DEPENDENTS",
          hint: `Remove the dependents first, or pass --force to unwire anyway (their builds will break).`,
          context: { dependents },
        },
      );
    }
  }

  // Update root: drop the matching entry.
  const rootRaw: Project = {
    ...stripResolved(root),
    workspaces: (root.workspaces ?? []).filter((rel) => rel !== matchedRel),
  };
  await writeProjectFile(rootProjectFile, rootRaw);

  let deletedFiles = false;
  if (opts.deleteFiles === true) {
    await rm(matchedDir, { recursive: true, force: true });
    deletedFiles = true;
  }

  const result: WorkspaceRemoveResult = {
    status: "success",
    exitCode: 0,
    name: opts.name,
    workspaceDir: matchedDir,
    rootProjectFile,
    deletedFiles,
  };
  emit(result as unknown as Record<string, unknown>, () => {
    log.heading(`Removed workspace ${bold(opts.name)}`);
    log.step(`${dim("→")} unwired from ${rootProjectFile}`);
    if (deletedFiles) log.step(`${dim("→")} deleted ${matchedDir}`);
    else log.step(`${dim("→")} files left at ${matchedDir}`);
  });
  return result;
}

export interface WorkspaceRenameOptions {
  oldName: string;
  newName: string;
  cwd?: string;
}

export interface WorkspaceRenameResult {
  status: "success";
  exitCode: 0;
  oldName: string;
  newName: string;
  /** Number of sibling workspaces whose `workspace:<old>` deps were rewritten. */
  dependentsRewritten: number;
}

export async function runWorkspaceRename(
  opts: WorkspaceRenameOptions,
): Promise<WorkspaceRenameResult> {
  if (!VALID_NAME_RE.test(opts.newName)) {
    throw new InvalidArgumentError(
      `new workspace name "${opts.newName}" is invalid: must start with a letter and contain only letters, digits, ".", "_", or "-".`,
    );
  }
  if (opts.oldName === opts.newName) {
    throw new InvalidArgumentError("new name is the same as the old name; nothing to do.");
  }

  const cwd = opts.cwd ?? process.cwd();
  const rootProjectFile = locateRootProjectFile(cwd);
  const root = resolveProjectFile(rootProjectFile);
  if (root === undefined) {
    throw new Error(`failed to read root project at ${rootProjectFile}`);
  }
  const rootDir = dirname(rootProjectFile);
  const declared = root.workspaces ?? [];

  // Find the workspace with old name; reject if new name already exists.
  let matchedRel: string | undefined;
  let matchedDir: string | undefined;
  for (const rel of declared) {
    const wsDir = resolveWorkspacePath(rootDir, rel);
    const wsProjectFile = join(wsDir, "project.json");
    const wsProject = resolveProjectFile(wsProjectFile);
    if (wsProject?.name === opts.oldName) {
      matchedRel = rel;
      matchedDir = wsDir;
    } else if (wsProject?.name === opts.newName) {
      throw new UserError(`workspace "${opts.newName}" already exists at ${rel}`, {
        code: "E_WORKSPACE_NAME_COLLISION",
        hint: "Pick a different new name, or remove the existing workspace first.",
      });
    }
  }
  if (matchedRel === undefined || matchedDir === undefined) {
    throw new UserError(`workspace "${opts.oldName}" is not declared in the root project`, {
      code: "E_WORKSPACE_NOT_FOUND",
    });
  }

  // Pre-flight: refuse to overwrite an unrelated dep keyed by the new name.
  // Rewrite would key the new entry as `opts.newName`; if a sibling (or the
  // root) already has a different dep under that key, we'd silently lose it.
  // Collect every conflict up front so we can list them all before any
  // write, and so the project never ends up in a partially-renamed state.
  const conflicts: Array<{ where: string; key: string; existingSource: string }> = [];
  const scanForConflicts = (file: string, project: Project | undefined): void => {
    if (project === undefined) return;
    for (const key of ["dependencies", "testDependencies"] as const) {
      const map = project[key];
      if (map === undefined) continue;
      const hasOldRef = Object.values(map).some(
        (raw) =>
          typeof raw === "object" && raw !== null && raw.source === `workspace:${opts.oldName}`,
      );
      if (!hasOldRef) continue;
      const existing = map[opts.newName];
      if (existing === undefined) continue;
      // The new-name key already exists. It's safe only when that entry is
      // ALSO the workspace:<old> ref being rewritten (same dep, idempotent).
      const isSameRef =
        typeof existing === "object" &&
        existing !== null &&
        existing.source === `workspace:${opts.oldName}`;
      if (isSameRef) continue;
      const existingSource =
        typeof existing === "string" ? existing : (existing as { source: string }).source;
      conflicts.push({ where: file, key: `${key}.${opts.newName}`, existingSource });
    }
  };
  for (const rel of declared) {
    if (rel === matchedRel) continue;
    const sibFile = join(resolveWorkspacePath(rootDir, rel), "project.json");
    scanForConflicts(sibFile, resolveProjectFile(sibFile));
  }
  scanForConflicts(rootProjectFile, root);
  if (conflicts.length > 0) {
    const lines = conflicts.map(
      (c) => `  • ${c.where}: ${c.key} already declared as ${c.existingSource}`,
    );
    throw new UserError(
      `cannot rename "${opts.oldName}" → "${opts.newName}": the new name collides with existing dep declarations:\n${lines.join("\n")}`,
      {
        code: "E_WORKSPACE_RENAME_COLLISION",
        hint: "Rename or remove the conflicting deps first, then retry.",
        context: { conflicts },
      },
    );
  }

  // 1. Rename the workspace's project.name.
  const wsProjectFile = join(matchedDir, "project.json");
  const wsProject = resolveProjectFile(wsProjectFile);
  if (wsProject === undefined) {
    throw new Error(`failed to read workspace project at ${wsProjectFile}`);
  }
  const renamedProject: Project = {
    ...stripResolved(wsProject),
    name: opts.newName,
  };
  await writeProjectFile(wsProjectFile, renamedProject);

  // 2. Rewrite every sibling's `workspace:<old>` references to use the new
  // name. Iterate `dependencies` (and `testDependencies` if present).
  // The pre-flight above guarantees the destination key is free.
  let dependentsRewritten = 0;
  for (const rel of declared) {
    if (rel === matchedRel) continue;
    const sibDir = resolveWorkspacePath(rootDir, rel);
    const sibFile = join(sibDir, "project.json");
    const sib = resolveProjectFile(sibFile);
    if (sib === undefined) continue;
    let changed = false;
    const next: Project = { ...stripResolved(sib) };
    for (const key of ["dependencies", "testDependencies"] as const) {
      const map = next[key];
      if (map === undefined) continue;
      const rewritten: Record<string, string | { source: string; version: string }> = {};
      for (const [depName, raw] of Object.entries(map)) {
        if (typeof raw === "object" && raw !== null && raw.source === `workspace:${opts.oldName}`) {
          // Rewrite the source AND the key, since the key is the public dep
          // name and matches the workspace name by convention.
          rewritten[opts.newName] = { source: `workspace:${opts.newName}`, version: raw.version };
          changed = true;
        } else {
          rewritten[depName] = raw;
        }
      }
      next[key] = rewritten;
    }
    if (changed) {
      await writeProjectFile(sibFile, next);
      dependentsRewritten++;
    }
  }

  // 3. Update root's `dependencies` / `testDependencies` if they reference
  // the renamed workspace too (rare, but possible).
  let rootChanged = false;
  const nextRoot: Project = { ...stripResolved(root) };
  for (const key of ["dependencies", "testDependencies"] as const) {
    const map = nextRoot[key];
    if (map === undefined) continue;
    const rewritten: Record<string, string | { source: string; version: string }> = {};
    for (const [depName, raw] of Object.entries(map)) {
      if (typeof raw === "object" && raw !== null && raw.source === `workspace:${opts.oldName}`) {
        rewritten[opts.newName] = { source: `workspace:${opts.newName}`, version: raw.version };
        rootChanged = true;
      } else {
        rewritten[depName] = raw;
      }
    }
    nextRoot[key] = rewritten;
  }
  if (rootChanged) {
    await writeProjectFile(rootProjectFile, nextRoot);
  }

  const result: WorkspaceRenameResult = {
    status: "success",
    exitCode: 0,
    oldName: opts.oldName,
    newName: opts.newName,
    dependentsRewritten,
  };
  emit(result as unknown as Record<string, unknown>, () => {
    log.heading(`Renamed workspace ${bold(opts.oldName)} → ${bold(opts.newName)}`);
    log.step(`${dim("→")} ${wsProjectFile}`);
    if (dependentsRewritten > 0) {
      log.step(
        `${dim("→")} rewrote workspace:${opts.oldName} → workspace:${opts.newName} in ${dependentsRewritten} sibling${dependentsRewritten === 1 ? "" : "s"}`,
      );
    }
    if (rootChanged) log.step(`${dim("→")} updated ${rootProjectFile}`);
  });
  return result;
}

/** Top-level `pluggy workspace` command. Subcommands attached below. */
export function workspaceCommand(): Command {
  const cmd = new Command("workspace").description(
    "Mutate the workspace graph (add, remove, rename, …).",
  );
  cmd.addCommand(workspaceAddSubcommand());
  cmd.addCommand(workspaceRemoveSubcommand());
  cmd.addCommand(workspaceRenameSubcommand());
  return cmd;
}

function workspaceRenameSubcommand(): Command {
  return new Command("rename")
    .alias("mv")
    .description("Rename a workspace and rewrite every workspace:<name> reference to match.")
    .argument("<old>", "Current workspace name.")
    .argument("<new>", "Desired workspace name.")
    .action(async function action(this: Command, oldName: string, newName: string) {
      await runWorkspaceRename({ oldName, newName });
    });
}

function workspaceRemoveSubcommand(): Command {
  return new Command("remove")
    .alias("rm")
    .description("Unwire a workspace from the root project.json (optionally deleting its files).")
    .argument("<name>", "Workspace name to remove.")
    .option("--delete", "Also recursively delete the workspace's directory.")
    .option("--force", "Remove even if other workspaces declare a workspace:<name> dep.")
    .action(async function action(this: Command, name: string, options) {
      await runWorkspaceRemove({
        name,
        deleteFiles: options.delete === true,
        force: options.force === true,
      });
    });
}

function workspaceAddSubcommand(): Command {
  return new Command("add")
    .description("Scaffold a new workspace and wire it into the root project.json.")
    .argument("<name>", "Workspace name (becomes the workspace's project.name).")
    .option("--main <fqcn>", "Fully-qualified main class; omit to scaffold an internal workspace.")
    .option(
      "--platforms <list>",
      "Comma-separated platforms (e.g. paper,sponge). Omit to inherit from root.",
      (raw: string) =>
        raw
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0),
    )
    .option(
      "--depends <list>",
      "Comma-separated workspace names to wire as workspace:<name> deps.",
      (raw: string) =>
        raw
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0),
    )
    .option("--dir <path>", "Override the on-disk directory (default: ./<name>).")
    .option("--version <semver>", "Initial workspace version (default: 0.1.0).")
    .action(async function action(this: Command, name: string, options) {
      await runWorkspaceAdd({
        name,
        main: options.main,
        platforms: options.platforms,
        depends: options.depends,
        dir: options.dir,
        version: options.version,
      });
    });
}
