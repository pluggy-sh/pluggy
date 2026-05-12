import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, stat, unlink, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { arch, platform, release } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";

import { Command } from "commander";

import { pickDescriptor } from "../build/descriptor.ts";
import { HOTSWAP_AGENT_VERSION } from "../dev/hotswap.ts";
import { JBR_VERSION, jbrCacheKey, jbrJavaPath, jbrTarget } from "../dev/jbr.ts";
import { classMajorToJava, readJarClassMajor, readManifestAttribute } from "../jar.ts";
import { type LockfileEntry, pruneOrphans, readLock, writeLock } from "../lockfile.ts";
import {
  type InstallMethod,
  describeInstallMethod,
  detectInstallMethod,
  findOtherInstalls,
} from "../install-method.ts";
import { bold, emit, emitErr, green, isJsonMode, log, red, yellow } from "../logging.ts";
import { platforms } from "../platform/index.ts";
import {
  getCachePath,
  getStatePath,
  primaryPlatform,
  primaryVersion,
  type Project,
  resolveProjectFile,
  type ResolvedProject,
  writeProjectFile,
} from "../project.ts";
import { registryUrl } from "../registry.ts";
import { getLatestModrinthVersion } from "../resolver/modrinth.ts";
import { getCachedJdk } from "../sdk/index.ts";
import { selectJdkForProject, selectJdkForVersion } from "../sdk/resolve.ts";
import { compareVersions, getCachedLatestVersion } from "../update-check.ts";
import { resolveWorkspaceContext, topologicalOrder, type WorkspaceContext } from "../workspace.ts";

export type CheckStatus = "pass" | "warn" | "fail";

export interface CheckResult {
  id: string;
  label: string;
  status: CheckStatus;
  detail?: string;
}

export interface EnvironmentInfo {
  pluggy: { version: string };
  os: { platform: NodeJS.Platform; release: string; arch: string };
  runtime: { name: "bun" | "node"; version: string };
  terminal: { isTTY: boolean; columns?: number };
  locale?: string;
  envVarsSet: string[];
  paths: { cache: string; state: string };
  install: {
    method: InstallMethod;
    label: string;
    binaryPath: string;
    otherInstalls: string[];
  };
  project?: {
    name: string;
    version: string;
    primaryPlatform?: string;
    primaryVersion?: string;
    workspaces: number;
    dependencies: number;
  };
  lockfile?: {
    version: number;
    entries: number;
    topLevel: number;
    transitive: number;
    orphans: number;
    lastModifiedAt?: string;
  };
}

export interface DoctorCommandOptions {
  cwd?: string;
  /**
   * Apply safe remediations after running checks. Currently:
   *   • prune orphan transitive entries from `pluggy.lock`.
   *   • drop `workspaces[]` entries that point at a missing folder.
   * Never deletes user code; only edits metadata files.
   */
  fix?: boolean;
  /** Current pluggy CLI version (without leading `v`). Used by the `pluggy-version` check. */
  pluggyVersion?: string;
  /** GitHub `owner/repo` slug used by the `pluggy-version` check. */
  repository?: string;
  /** When true, render the paste-friendly markdown report instead of the human banner. */
  report?: boolean;
  /** Per-check overrides used by tests to avoid spawning a JVM or hitting the network. */
  checks?: {
    java?: () => Promise<CheckResult>;
    sdk?: (project: ResolvedProject) => Promise<CheckResult>;
    cache?: () => Promise<CheckResult>;
    registries?: (project: ResolvedProject) => Promise<CheckResult[]>;
    project?: (project: ResolvedProject) => CheckResult;
    workspace?: (ctx: WorkspaceContext) => CheckResult;
    descriptor?: (ctx: WorkspaceContext) => CheckResult[];
    versions?: (project: ResolvedProject) => Promise<CheckResult[]>;
    jdkPin?: (project: ResolvedProject) => Promise<CheckResult | undefined>;
    docsFlag?: (project: ResolvedProject) => CheckResult | undefined;
    outdated?: () => Promise<CheckResult>;
    dependencyJars?: () => Promise<CheckResult>;
    pluggyVersion?: () => Promise<CheckResult>;
  };
}

export interface DoctorCommandResult {
  ok: boolean;
  exitCode: 0 | 1;
  environment: EnvironmentInfo;
  checks: CheckResult[];
  summary: { passed: number; warned: number; failed: number };
  /** Populated when `fix: true` and at least one remediation ran. */
  fixes?: Array<{ id: string; detail: string }>;
}

/** Env var names that influence pluggy's behaviour. Names only; never values. */
const TRACKED_ENV_VARS = [
  "APPDATA",
  "CI",
  "DEBUG",
  "JAVA_HOME",
  "LOCALAPPDATA",
  "NO_COLOR",
  "PLUGGY_NO_AUTO_INSTALL",
  "PLUGGY_NO_UPDATE_CHECK",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
] as const;

/**
 * Run every environment and project-validation check, returning the
 * aggregated verdict. `exitCode` is 1 iff any check has `status: "fail"`;
 * warns are informational only.
 *
 * When invoked outside a pluggy project, `runDoctorCommand` still produces
 * a partial `EnvironmentInfo` and a single `project-found` failed check
 * rather than throwing. That way `pluggy doctor` is useful even when the
 * user is debugging "no project found" issues.
 */
export async function runDoctorCommand(
  opts: DoctorCommandOptions = {},
): Promise<DoctorCommandResult> {
  const cwd = opts.cwd ?? process.cwd();

  // When `--fix` is set, run the structural-repair pass FIRST so the rest of
  // doctor can resolve the workspace context. `resolveWorkspaceContext`
  // hard-fails on a declared-but-missing workspace folder; pruning those
  // entries up front lets the rest of doctor proceed.
  const preFixes = opts.fix === true ? prefixMissingWorkspaces(cwd) : [];

  const context = resolveWorkspaceContext(cwd);

  if (context === undefined) {
    const environment = collectEnvironmentInfo(opts.pluggyVersion);
    const noProjectCheck: CheckResult = {
      id: "project-found",
      label: "Project found",
      status: "fail",
      detail: "no pluggy project found from this directory; run `pluggy init` to create one",
    };
    return finalizeAndEmit({
      opts,
      environment,
      checks: [noProjectCheck],
    });
  }

  const hooks = opts.checks ?? {};
  const all: CheckResult[] = [];

  let userJava: number | undefined;
  let javaError: string | undefined;
  try {
    userJava = await getJavaMajor();
  } catch (err) {
    javaError = err instanceof Error ? err.message : String(err);
  }

  all.push(await (hooks.java ? hooks.java() : checkJava(context, userJava, javaError)));
  const sdkProject = context.current?.project ?? context.root;
  all.push(await (hooks.sdk ? hooks.sdk(sdkProject) : checkSdk(sdkProject)));
  all.push(await (hooks.cache ? hooks.cache() : checkCache()));
  all.push(checkHotswap());

  const registryProject = context.current?.project ?? context.root;
  const regResults = await (hooks.registries
    ? hooks.registries(registryProject)
    : checkRegistries(registryProject));
  all.push(...regResults);

  // Validate every workspace so one bad leaf surfaces even if the root is fine.
  const toValidate = projectsForValidation(context);
  for (const project of toValidate) {
    all.push(hooks.project ? hooks.project(project) : checkProjectValid(project));
  }

  for (const project of toValidate) {
    const verResults = await (hooks.versions
      ? hooks.versions(project)
      : checkVersionCompatibility(project));
    all.push(...verResults);
  }

  for (const project of toValidate) {
    const jdkResult = await (hooks.jdkPin ? hooks.jdkPin(project) : checkJdkPin(project));
    if (jdkResult !== undefined) all.push(jdkResult);
  }

  for (const project of toValidate) {
    const docsResult = hooks.docsFlag ? hooks.docsFlag(project) : checkDocsFlag(project);
    if (docsResult !== undefined) all.push(docsResult);
  }

  all.push(hooks.workspace ? hooks.workspace(context) : checkWorkspaceGraph(context));

  const descResults = hooks.descriptor ? hooks.descriptor(context) : checkDescriptors(context);
  all.push(...descResults);

  all.push(await (hooks.outdated ? hooks.outdated() : checkOutdated(context)));
  all.push(
    await (hooks.dependencyJars ? hooks.dependencyJars() : checkDependencyJars(context, userJava)),
  );

  if (hooks.pluggyVersion) {
    all.push(await hooks.pluggyVersion());
  } else if (opts.pluggyVersion !== undefined && opts.repository !== undefined) {
    all.push(await checkPluggyVersion(opts.pluggyVersion, opts.repository));
  }

  // The lockfile check only makes sense when at least one workspace has
  // declared deps; otherwise there's nothing to lock and the check is noise.
  const hasDeclaredDeps = projectsForValidation(context).some(
    (p) => Object.keys(p.dependencies ?? {}).length > 0,
  );
  if (hasDeclaredDeps) {
    all.push(checkLockfile(context));
  }

  const environment = await collectEnvironmentInfoForContext(context, opts.pluggyVersion);

  const inlineFixes = opts.fix === true ? await applyFixes(context) : undefined;
  const fixes = combineFixes(preFixes, inlineFixes);

  return finalizeAndEmit({ opts, environment, checks: all, fixes });
}

function combineFixes(
  pre: Array<{ id: string; detail: string }>,
  post: DoctorCommandResult["fixes"],
): DoctorCommandResult["fixes"] {
  const combined: Array<{ id: string; detail: string }> = [...pre, ...(post ?? [])];
  return combined.length > 0 ? combined : undefined;
}

/**
 * Synchronously prune missing-folder workspace entries from the root
 * `project.json`. Runs before `resolveWorkspaceContext` so the rest of
 * doctor can proceed even when the user has deleted a workspace folder
 * by hand.
 */
function prefixMissingWorkspaces(cwd: string): Array<{ id: string; detail: string }> {
  const fixes: Array<{ id: string; detail: string }> = [];
  // Walk upward to the nearest project.json (matches resolveWorkspaceContext).
  let dir = cwd;
  while (true) {
    const candidate = join(dir, "project.json");
    if (existsSync(candidate)) {
      const raw = resolveProjectFile(candidate);
      if (raw === undefined || !Array.isArray(raw.workspaces)) return fixes;
      const kept: string[] = [];
      const dropped: string[] = [];
      for (const rel of raw.workspaces) {
        const wsPath = rel.startsWith("./") ? rel.slice(2) : rel;
        const abs = join(dir, wsPath);
        if (existsSync(join(abs, "project.json"))) kept.push(rel);
        else dropped.push(rel);
      }
      if (dropped.length > 0) {
        const { rootDir: _r, projectFile: _p, ...rest } = raw;
        const next: Project = { ...rest, workspaces: kept };
        writeFileSync(candidate, `${JSON.stringify(next, null, 2)}\n`, "utf8");
        fixes.push({
          id: "workspace-prune",
          detail: `removed ${dropped.length} missing workspace${dropped.length === 1 ? "" : "s"} from root project.json (${dropped.join(", ")})`,
        });
      }
      return fixes;
    }
    const parent = dirname(dir);
    if (parent === dir) return fixes;
    dir = parent;
  }
}

/**
 * Apply safe, mechanical remediations to the project's metadata. Each fix
 * is non-destructive: edits `pluggy.lock` or `project.json` only, never
 * removes source files.
 */
async function applyFixes(context: WorkspaceContext): Promise<DoctorCommandResult["fixes"]> {
  const fixes: NonNullable<DoctorCommandResult["fixes"]> = [];

  // Fix 1: prune orphan transitive entries from the lockfile.
  const lock = readLock(context.root.rootDir);
  if (lock !== null) {
    const before = Object.keys(lock.entries).length;
    pruneOrphans(lock.entries);
    const after = Object.keys(lock.entries).length;
    if (before !== after) {
      await writeLock(context.root.rootDir, lock);
      fixes.push({
        id: "lockfile-prune",
        detail: `pruned ${before - after} orphan entr${before - after === 1 ? "y" : "ies"} from pluggy.lock`,
      });
    }
  }

  // Fix 2: drop `workspaces[]` entries that point at a missing folder.
  // The folder might have been deleted by hand; pluggy should adapt rather
  // than refusing to do anything until the user edits the root.
  const rootRaw = resolveProjectFile(context.root.projectFile);
  if (rootRaw !== undefined && Array.isArray(rootRaw.workspaces)) {
    const kept: string[] = [];
    const dropped: string[] = [];
    for (const rel of rootRaw.workspaces) {
      const wsPath = rel.startsWith("./") ? rel.slice(2) : rel;
      const abs = join(context.root.rootDir, wsPath);
      if (existsSync(join(abs, "project.json"))) {
        kept.push(rel);
      } else {
        dropped.push(rel);
      }
    }
    if (dropped.length > 0) {
      const { rootDir: _r, projectFile: _p, ...rest } = rootRaw;
      const next: Project = { ...rest, workspaces: kept };
      await writeProjectFile(context.root.projectFile, next);
      fixes.push({
        id: "workspace-prune",
        detail: `removed ${dropped.length} missing workspace${dropped.length === 1 ? "" : "s"} from root project.json (${dropped.join(", ")})`,
      });
    }
  }

  return fixes.length > 0 ? fixes : undefined;
}

interface FinalizeArgs {
  opts: DoctorCommandOptions;
  environment: EnvironmentInfo;
  checks: CheckResult[];
  fixes?: DoctorCommandResult["fixes"];
}

function finalizeAndEmit(args: FinalizeArgs): DoctorCommandResult {
  const { opts, environment, checks, fixes } = args;
  const summary = summarize(checks);
  const ok = summary.failed === 0;
  const exitCode: 0 | 1 = ok ? 0 : 1;

  const failures = checks.filter((c) => c.status === "fail");
  const result: DoctorCommandResult = { ok, exitCode, environment, checks, summary, fixes };

  // `--report` short-circuits the human renderer, but `--json` still wins.
  if (opts.report === true && !isJsonMode()) {
    console.log(renderReport(result));
    return result;
  }

  const payload = {
    status: ok ? "success" : "error",
    ok,
    environment,
    checks,
    summary,
    failures,
    fixes,
  };
  const printHuman = (): void => printHumanReport(result);
  if (ok) emit(payload, printHuman);
  else emitErr(payload, printHuman);

  return result;
}

function summarize(checks: CheckResult[]): { passed: number; warned: number; failed: number } {
  let passed = 0;
  let warned = 0;
  let failed = 0;
  for (const c of checks) {
    if (c.status === "pass") passed++;
    else if (c.status === "warn") warned++;
    else failed++;
  }
  return { passed, warned, failed };
}

// ---------------------------------------------------------------------------
// Environment collection
// ---------------------------------------------------------------------------

/** Detect the JS runtime. Bun exposes `process.versions.bun`; Node does not. */
function detectRuntime(): { name: "bun" | "node"; version: string } {
  const bunVersion = process.versions.bun;
  if (typeof bunVersion === "string" && bunVersion.length > 0) {
    return { name: "bun", version: bunVersion };
  }
  return { name: "node", version: process.versions.node };
}

/** Pick the most specific locale env var that's set. */
function detectLocale(): string | undefined {
  const order = ["LC_ALL", "LC_MESSAGES", "LANG", "LANGUAGE"];
  for (const name of order) {
    const value = process.env[name];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

/** Collect names (never values) of pluggy-relevant env vars that are set. */
function collectEnvVarsSet(): string[] {
  const out: string[] = [];
  for (const name of TRACKED_ENV_VARS) {
    if (process.env[name] !== undefined) out.push(name);
  }
  // Caller-visible alphabetical order. The tracked list is already sorted,
  // but sorting again keeps the contract explicit if the source list moves.
  out.sort();
  return out;
}

/**
 * Build the environment block without project-specific data. Used when
 * doctor runs outside a pluggy project, so we still surface OS / runtime
 * context for the bug report.
 */
function collectEnvironmentInfo(pluggyVersion?: string): EnvironmentInfo {
  const installInfo = detectInstallMethod();
  const env: EnvironmentInfo = {
    pluggy: { version: pluggyVersion ?? "0.0.0" },
    os: { platform: platform(), release: release(), arch: arch() },
    runtime: detectRuntime(),
    terminal: { isTTY: process.stdout.isTTY === true },
    envVarsSet: collectEnvVarsSet(),
    paths: { cache: getCachePath(), state: getStatePath() },
    install: {
      method: installInfo.method,
      label: describeInstallMethod(installInfo.method),
      binaryPath: installInfo.resolvedPath,
      otherInstalls: findOtherInstalls(installInfo.resolvedPath),
    },
  };
  if (typeof process.stdout.columns === "number" && process.stdout.columns > 0) {
    env.terminal.columns = process.stdout.columns;
  }
  const locale = detectLocale();
  if (locale !== undefined) env.locale = locale;
  return env;
}

/** Build the full environment block, populating project + lockfile sections. */
async function collectEnvironmentInfoForContext(
  context: WorkspaceContext,
  pluggyVersion?: string,
): Promise<EnvironmentInfo> {
  const env = collectEnvironmentInfo(pluggyVersion);

  const target = context.current?.project ?? context.root;
  let primaryPlatformName: string | undefined;
  let primaryVersionName: string | undefined;
  try {
    primaryPlatformName = primaryPlatform(target);
  } catch {
    primaryPlatformName = undefined;
  }
  try {
    primaryVersionName = primaryVersion(target);
  } catch {
    primaryVersionName = undefined;
  }

  const dependencyNames = new Set<string>();
  for (const project of projectsForValidation(context)) {
    for (const name of Object.keys(project.dependencies ?? {})) dependencyNames.add(name);
  }

  env.project = {
    name: target.name,
    version: target.version,
    primaryPlatform: primaryPlatformName,
    primaryVersion: primaryVersionName,
    workspaces: context.workspaces.length,
    dependencies: dependencyNames.size,
  };

  const lockSummary = await collectLockfileInfo(context.root.rootDir);
  if (lockSummary !== undefined) env.lockfile = lockSummary;

  return env;
}

/** Stat + summarize `pluggy.lock`. Returns `undefined` when the lockfile is absent. */
async function collectLockfileInfo(rootDir: string): Promise<EnvironmentInfo["lockfile"]> {
  let lock;
  try {
    lock = readLock(rootDir);
  } catch {
    // A malformed lockfile is reported by other checks; don't crash environment collection.
    return undefined;
  }
  if (lock === null) return undefined;

  const total = Object.keys(lock.entries).length;
  let topLevel = 0;
  for (const entry of Object.values(lock.entries)) {
    if (entry.declaredBy.length > 0) topLevel++;
  }
  const transitive = total - topLevel;

  // Clone the entries map so pruneOrphans doesn't mutate the live lockfile.
  const cloned: Record<string, LockfileEntry> = {};
  for (const [name, entry] of Object.entries(lock.entries)) {
    cloned[name] = entry;
  }
  pruneOrphans(cloned);
  const orphans = total - Object.keys(cloned).length;

  let lastModifiedAt: string | undefined;
  try {
    const s = await stat(join(rootDir, "pluggy.lock"));
    lastModifiedAt = s.mtime.toISOString();
  } catch {
    // mtime is best-effort; missing it is not a hard failure.
  }

  const summary: NonNullable<EnvironmentInfo["lockfile"]> = {
    version: lock.version,
    entries: total,
    topLevel,
    transitive,
    orphans,
  };
  if (lastModifiedAt !== undefined) summary.lastModifiedAt = lastModifiedAt;
  return summary;
}

// ---------------------------------------------------------------------------
// Lockfile orphan check
// ---------------------------------------------------------------------------

/**
 * Re-read the lockfile, prune orphans, and warn when any transitive entries
 * are no longer reachable from the declared top-level set. `pluggy install`
 * cleans these up; doctor surfaces them so users notice without having to
 * scan the file manually.
 */
export function checkLockfile(context: WorkspaceContext): CheckResult {
  const id = "lockfile";
  const label = "Lockfile";
  let lock;
  try {
    lock = readLock(context.root.rootDir);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { id, label, status: "fail", detail: message };
  }
  if (lock === null) {
    return { id, label, status: "pass", detail: "no lockfile (run pluggy install)" };
  }

  const total = Object.keys(lock.entries).length;
  if (total === 0) {
    return { id, label, status: "pass", detail: "lockfile empty" };
  }

  const cloned: Record<string, LockfileEntry> = {};
  for (const [name, entry] of Object.entries(lock.entries)) {
    cloned[name] = entry;
  }
  pruneOrphans(cloned);
  const orphans = total - Object.keys(cloned).length;

  if (orphans > 0) {
    return {
      id,
      label,
      status: "warn",
      detail: `${orphans} orphan transitive${orphans === 1 ? "" : "s"}; run pluggy install to clean up`,
    };
  }

  // Coverage: every declared dep (post-inheritance) must have a lockfile entry.
  // Without this, a workspace that inherits a dep but was never re-installed
  // can silently drift and only surface as a build error later.
  const missing: Array<{ workspace: string; name: string }> = [];
  const lockEntryNames = new Set(Object.keys(lock.entries));
  for (const node of context.workspaces.length > 0 ? context.workspaces : []) {
    for (const depName of Object.keys(node.project.dependencies ?? {})) {
      if (!lockEntryNames.has(depName)) {
        missing.push({ workspace: node.name, name: depName });
      }
    }
  }
  if (context.workspaces.length === 0) {
    for (const depName of Object.keys(context.root.dependencies ?? {})) {
      if (!lockEntryNames.has(depName)) {
        missing.push({ workspace: context.root.name, name: depName });
      }
    }
  }
  if (missing.length > 0) {
    const sample = missing
      .slice(0, 3)
      .map((m) => `${m.workspace}:${m.name}`)
      .join(", ");
    const ellipsis = missing.length > 3 ? `, +${missing.length - 3} more` : "";
    return {
      id,
      label,
      status: "warn",
      detail: `${missing.length} declared dep${missing.length === 1 ? "" : "s"} missing from lockfile (${sample}${ellipsis}); run pluggy install`,
    };
  }

  return {
    id,
    label,
    status: "pass",
    detail: `${total} entr${total === 1 ? "y" : "ies"}, no orphans`,
  };
}

/**
 * Warn when a shipping workspace (one with `main`) has `docs: false`. The
 * combination is legal but usually a mistake — a published plugin typically
 * wants Javadoc generated. Internal workspaces (no `main`) with `docs: false`
 * are silent: that's the intended use case.
 */
export function checkDocsFlag(project: ResolvedProject): CheckResult | undefined {
  if (project.docs !== false) return undefined;
  if (project.main === undefined) return undefined;
  return {
    id: "docs-flag",
    label: `Docs flag (${project.name})`,
    status: "warn",
    detail: `shipping workspace declares "docs": false; pluggy docs at the root will skip it`,
  };
}

/**
 * Compare a workspace's pinned `jdk.major` against what its primary MC version
 * would select on its own. A mismatch is a common foot-gun when a workspace
 * inherits a root-level `jdk` pin but targets a different MC version. Returns
 * `undefined` when there's no pin to check or no MC version to compare to.
 */
export async function checkJdkPin(project: ResolvedProject): Promise<CheckResult | undefined> {
  const pinned = project.jdk?.major;
  if (pinned === undefined) return undefined;

  const mcVersion = project.compatibility?.versions?.[0];
  if (mcVersion === undefined) return undefined;

  const implied = await selectJdkForVersion(
    { ...project, jdk: undefined } as ResolvedProject,
    mcVersion,
  );
  const label = `JDK pin (${project.name})`;
  if (implied.major !== pinned) {
    return {
      id: "jdk-pin",
      label,
      status: "warn",
      detail: `pinned major ${pinned} differs from MC ${mcVersion} default (${implied.major}); confirm the pin is intentional`,
    };
  }
  return {
    id: "jdk-pin",
    label,
    status: "pass",
    detail: `major ${pinned} matches MC ${mcVersion} default`,
  };
}

// ---------------------------------------------------------------------------
// Java
// ---------------------------------------------------------------------------

/**
 * Spawn `java -version` and return the parsed major version number.
 * Returns `undefined` if the version string cannot be parsed.
 * Throws if Java is not installed or the process fails.
 */
export async function getJavaMajor(): Promise<number | undefined> {
  const out = await runJavaVersion();
  const combined = `${out.stdout}\n${out.stderr}`;
  const match =
    combined.match(/version "(\d+)(?:\.(\d+))?[^"]*"/) ??
    combined.match(/version (\d+)(?:\.(\d+))?/);
  if (!match) return undefined;
  return Number.parseInt(match[1] === "1" && match[2] !== undefined ? match[2] : match[1], 10);
}

/**
 * Check the Java toolchain version. For spigot/bukkit projects, reads the
 * minimum required Java version from the cached `BuildTools.jar` manifest
 * so the check stays accurate as BuildTools is updated.
 *
 * Accepts pre-resolved `userJava` / `javaError` from `runDoctorCommand` to
 * avoid spawning `java -version` more than once per doctor run.
 */
export async function checkJava(
  context: WorkspaceContext,
  userJava?: number,
  javaError?: string,
): Promise<CheckResult> {
  if (javaError !== undefined) {
    return {
      id: "java",
      label: "Java toolchain",
      status: "fail",
      detail: `java not found or failed to run: ${javaError}`,
    };
  }
  if (userJava === undefined) {
    return {
      id: "java",
      label: "Java toolchain",
      status: "fail",
      detail: "java not found or could not parse version",
    };
  }

  const detail = `Java ${userJava}`;
  const target = context.current?.project ?? context.root;
  const platformName = target.compatibility?.platforms?.[0];

  if (platformName === "spigot" || platformName === "bukkit") {
    const buildToolsPath = join(getCachePath(), "BuildTools.jar");
    const jdkSpec = await readManifestAttribute(buildToolsPath, "Build-Jdk-Spec");
    const minJava = jdkSpec !== undefined ? Number.parseInt(jdkSpec, 10) : 8;
    if (!Number.isNaN(minJava) && userJava < minJava) {
      return {
        id: "java",
        label: "Java toolchain",
        status: "warn",
        detail: `${detail}; BuildTools requires Java ${minJava}+`,
      };
    }
  }

  return { id: "java", label: "Java toolchain", status: "pass", detail };
}

async function runJavaVersion(): Promise<{ stdout: string; stderr: string }> {
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("java", ["-version"], { shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (b: Buffer) => {
      stdout += b.toString("utf8");
    });
    child.stderr?.on("data", (b: Buffer) => {
      stderr += b.toString("utf8");
    });
    child.once("error", rejectPromise);
    child.once("close", (code) => {
      if (code === 0 || code === null) resolvePromise({ stdout, stderr });
      else rejectPromise(new Error(`java -version exited with code ${code}: ${stderr.trim()}`));
    });
  });
}

/**
 * Verify the JDK pluggy needs for this project is provisioned (or auto-installable).
 *
 * Three states:
 *   pass: the slot is cached or JAVA_HOME points at the right major.
 *   warn: the slot is missing but auto-install is enabled, so the next
 *         build will fetch it. Still actionable for users on slow networks.
 *   fail: the slot is missing and `PLUGGY_NO_AUTO_INSTALL=1` is set, so
 *         the next build would fail. Includes the remediation command.
 */
export async function checkSdk(project: ResolvedProject): Promise<CheckResult> {
  const selection = await selectJdkForProject(project);
  const cached = getCachedJdk(selection.major, selection.distribution);
  const noAutoInstall = process.env.PLUGGY_NO_AUTO_INSTALL === "1";
  const remedy = `pluggy sdk install ${selection.major}${selection.distribution === "temurin" ? "" : ` --distribution ${selection.distribution}`}`;

  if (cached !== undefined) {
    return {
      id: "sdk",
      label: "Project JDK",
      status: "pass",
      detail: `${selection.distribution} ${selection.major} cached (${cached.javaHome})`,
    };
  }

  if (noAutoInstall) {
    return {
      id: "sdk",
      label: "Project JDK",
      status: "fail",
      detail: `${selection.distribution} ${selection.major} not installed and PLUGGY_NO_AUTO_INSTALL=1. Run: ${remedy}`,
    };
  }

  return {
    id: "sdk",
    label: "Project JDK",
    status: "warn",
    detail: `${selection.distribution} ${selection.major} not yet installed; pluggy will fetch on first build. Pre-install: ${remedy}`,
  };
}

/**
 * Stat the cache directory and verify it's writable by touching a temp file.
 * Reports size as the detail string on the pass result.
 */
export async function checkCache(): Promise<CheckResult> {
  const path = getCachePath();
  try {
    const s = await stat(path).catch(() => undefined);
    if (s === undefined) {
      return {
        id: "cache",
        label: "Cache reachability",
        status: "warn",
        detail: `cache directory does not exist yet: ${path}`,
      };
    }
    if (!s.isDirectory()) {
      return {
        id: "cache",
        label: "Cache reachability",
        status: "fail",
        detail: `cache path exists but is not a directory: ${path}`,
      };
    }
    const probe = join(path, `.pluggy-doctor-probe-${process.pid}`);
    try {
      await writeFile(probe, "");
      await unlink(probe);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        id: "cache",
        label: "Cache reachability",
        status: "fail",
        detail: `cache is not writable: ${path} (${message})`,
      };
    }
    const sizeBytes = await dirSize(path);
    return {
      id: "cache",
      label: "Cache reachability",
      status: "pass",
      detail: `${path} (${formatBytes(sizeBytes)})`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      id: "cache",
      label: "Cache reachability",
      status: "fail",
      detail: `could not stat cache at ${path}: ${message}`,
    };
  }
}

/**
 * Report whether HotswapAgent + JBR are present in the user cache. Both
 * download on first `pluggy dev` run, so a missing cache is informational
 * rather than a failure. We surface it so users know what the first dev
 * launch will do.
 */
export function checkHotswap(): CheckResult {
  const cacheRoot = getCachePath();
  const agentPath = join(cacheRoot, "agents", `hotswap-agent-${HOTSWAP_AGENT_VERSION}.jar`);
  let target;
  try {
    target = jbrTarget();
  } catch (err) {
    return {
      id: "hotswap",
      label: "HotswapAgent + JBR",
      status: "warn",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  const jbrPath = jbrJavaPath(join(cacheRoot, "jbr", jbrCacheKey(target)), target);

  const agentReady = existsSync(agentPath);
  const jbrReady = existsSync(jbrPath);

  if (agentReady && jbrReady) {
    return {
      id: "hotswap",
      label: "HotswapAgent + JBR",
      status: "pass",
      detail: `agent ${HOTSWAP_AGENT_VERSION}, JBR ${JBR_VERSION} cached`,
    };
  }
  const missing: string[] = [];
  if (!agentReady) missing.push(`HotswapAgent ${HOTSWAP_AGENT_VERSION}`);
  if (!jbrReady) missing.push(`JBR ${JBR_VERSION} (${target.os}-${target.arch})`);
  return {
    id: "hotswap",
    label: "HotswapAgent + JBR",
    status: "pass",
    detail: `${missing.join(" + ")} will download on first \`pluggy dev\``,
  };
}

async function dirSize(path: string): Promise<number> {
  let total = 0;
  async function walk(current: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        try {
          const s = await stat(full);
          total += s.size;
        } catch {
          // ignore unreadable entries
        }
      }
    }
  }
  await walk(path);
  return total;
}

/** HEAD each declared registry URL; warn on non-2xx/4xx or network failure. */
export async function checkRegistries(project: ResolvedProject): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  const registries = project.registries ?? [];
  if (registries.length === 0) {
    return [
      {
        id: "registry",
        label: "Registries",
        status: "pass",
        detail: "no extra registries declared",
      },
    ];
  }
  for (const entry of registries) {
    out.push(await checkOneRegistry(registryUrl(entry)));
  }
  return out;
}

async function checkOneRegistry(url: string): Promise<CheckResult> {
  const label = `Registry ${url}`;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(url, { method: "HEAD", signal: controller.signal });
      if (res.ok || (res.status >= 200 && res.status < 500)) {
        return { id: "registry", label, status: "pass", detail: `HTTP ${res.status}` };
      }
      return {
        id: "registry",
        label,
        status: "warn",
        detail: `HTTP ${res.status}`,
      };
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { id: "registry", label, status: "warn", detail: `unreachable: ${message}` };
  }
}

const NAME_RE = /^[a-zA-Z0-9_-]+$/;
const VERSION_RE = /^\d+\.\d+\.\d+(-[a-zA-Z0-9]+)?$/;

/**
 * Validate the structural fields of a single `project.json`. Names the
 * offending field in `detail` so CI output points at the right key.
 */
export function checkProjectValid(project: ResolvedProject): CheckResult {
  const label = `project.json (${project.name ?? "unknown"})`;
  if (typeof project.name !== "string" || !NAME_RE.test(project.name)) {
    return {
      id: "project",
      label,
      status: "fail",
      detail: `invalid or missing "name": ${String(project.name)}`,
    };
  }
  if (typeof project.version !== "string" || !VERSION_RE.test(project.version)) {
    return {
      id: "project",
      label,
      status: "fail",
      detail: `invalid or missing "version": ${String(project.version)}`,
    };
  }
  const compat = project.compatibility;
  if (
    compat === undefined ||
    compat === null ||
    !Array.isArray(compat.versions) ||
    compat.versions.length === 0 ||
    !Array.isArray(compat.platforms) ||
    compat.platforms.length === 0
  ) {
    return {
      id: "project",
      label,
      status: "fail",
      detail: `"compatibility" must declare non-empty "versions" and "platforms"`,
    };
  }
  for (const p of compat.platforms) {
    if (!platforms.list().includes(p)) {
      return {
        id: "project",
        label,
        status: "fail",
        detail: `unknown platform "${p}" (known: ${platforms.list().join(", ")})`,
      };
    }
  }
  return {
    id: "project",
    label,
    status: "pass",
    detail: `name=${project.name}, version=${project.version}`,
  };
}

/**
 * Verify that every declared version in `compatibility.versions` is actually
 * available on every declared platform. Catches mismatches like Paper 26.x
 * being listed for Spigot (which hasn't published that version).
 */
export async function checkVersionCompatibility(project: ResolvedProject): Promise<CheckResult[]> {
  const { versions, platforms: declaredPlatforms } = project.compatibility ?? {};
  if (!versions?.length || !declaredPlatforms?.length) return [];

  const out: CheckResult[] = [];
  for (const platformName of declaredPlatforms) {
    let available: string[];
    try {
      available = await platforms.get(platformName).versions();
    } catch {
      out.push({
        id: "version-compat",
        label: `Version compatibility (${platformName})`,
        status: "warn",
        detail: `could not fetch version list for ${platformName}`,
      });
      continue;
    }
    const set = new Set(available);
    const missing = versions.filter((v) => !set.has(v));
    if (missing.length > 0) {
      out.push({
        id: "version-compat",
        label: `Version compatibility (${platformName})`,
        status: "fail",
        detail: `${platformName} does not publish version${missing.length > 1 ? "s" : ""} ${missing.join(", ")}`,
      });
    } else {
      out.push({
        id: "version-compat",
        label: `Version compatibility (${platformName})`,
        status: "pass",
        detail: `${versions.join(", ")}`,
      });
    }
  }
  return out;
}

/** Run topological order over workspaces; fails on cycles. */
export function checkWorkspaceGraph(context: WorkspaceContext): CheckResult {
  const label = "Workspace graph";
  if (context.workspaces.length === 0) {
    return { id: "workspace", label, status: "pass", detail: "standalone project" };
  }
  try {
    const ordered = topologicalOrder(context.workspaces);
    return {
      id: "workspace",
      label,
      status: "pass",
      detail: `${ordered.length} workspace(s): ${ordered.map((w) => w.name).join(" -> ")}`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { id: "workspace", label, status: "fail", detail: message };
  }
}

/**
 * Run `pickDescriptor` across every buildable project so cross-family
 * compatibility errors are surfaced before a build attempts them.
 */
export function checkDescriptors(context: WorkspaceContext): CheckResult[] {
  const targets =
    context.workspaces.length > 0 ? context.workspaces.map((w) => w.project) : [context.root];

  const out: CheckResult[] = [];
  for (const project of targets) {
    // The root in a multi-workspace repo has no descriptor of its own.
    if (context.workspaces.length > 0 && project === context.root) continue;

    const label = `Descriptor family (${project.name})`;
    try {
      const desc = pickDescriptor(project);
      out.push({
        id: "descriptor",
        label,
        status: "pass",
        detail: `${primaryPlatform(project)} → ${desc.path}`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      out.push({ id: "descriptor", label, status: "fail", detail: message });
    }
  }
  if (out.length === 0) {
    out.push({
      id: "descriptor",
      label: "Descriptor family",
      status: "pass",
      detail: "no plugin workspaces to check",
    });
  }
  return out;
}

/**
 * Compare every Modrinth-sourced dep in the root lockfile against the
 * current newest stable on Modrinth. Reports `pass` when nothing is behind,
 * `warn` (non-fatal) with a list of `<name>: current → latest` entries when
 * anything is outdated. Network failures degrade to `warn` with a note so
 * a flaky Modrinth doesn't block `doctor`.
 */
export async function checkOutdated(context: WorkspaceContext): Promise<CheckResult> {
  const lock = readLock(context.root.rootDir);
  const modrinthEntries: Array<[string, LockfileEntry]> =
    lock === null
      ? []
      : Object.entries(lock.entries).filter(([, entry]) => entry.source.kind === "modrinth");

  if (modrinthEntries.length === 0) {
    return {
      id: "outdated",
      label: "Outdated dependencies",
      status: "pass",
      detail: "no Modrinth dependencies locked",
    };
  }

  const outdated: string[] = [];
  const errors: string[] = [];
  for (const [name, entry] of modrinthEntries) {
    if (entry.source.kind !== "modrinth") continue;
    try {
      const latest = await getLatestModrinthVersion(entry.source.slug, false);
      if (latest === undefined) continue;
      if (latest !== entry.resolvedVersion) {
        outdated.push(`${name}: ${entry.resolvedVersion} → ${latest}`);
      }
    } catch (err) {
      errors.push(`${name}: ${(err as Error).message}`);
    }
  }

  if (errors.length > 0) {
    return {
      id: "outdated",
      label: "Outdated dependencies",
      status: "warn",
      detail: `could not query ${errors.length} deps: ${errors.slice(0, 3).join("; ")}`,
    };
  }
  if (outdated.length === 0) {
    return {
      id: "outdated",
      label: "Outdated dependencies",
      status: "pass",
      detail: `${modrinthEntries.length} deps up to date`,
    };
  }
  return {
    id: "outdated",
    label: "Outdated dependencies",
    status: "warn",
    detail: outdated.join("; "),
  };
}

/**
 * For every cached dependency JAR in the lockfile, read its class-file
 * bytecode version and warn if any require a higher Java release than the
 * active toolchain provides.
 */
export async function checkDependencyJars(
  context: WorkspaceContext,
  userJava?: number,
): Promise<CheckResult> {
  const lock = readLock(context.root.rootDir);
  if (lock === null || Object.keys(lock.entries).length === 0) {
    return {
      id: "dep-jars",
      label: "Dependency compatibility",
      status: "pass",
      detail: "no dependencies locked",
    };
  }

  if (userJava === undefined) {
    return {
      id: "dep-jars",
      label: "Dependency compatibility",
      status: "pass",
      detail: "java not available, skipped",
    };
  }

  type FlatEntry = { name: string; entry: LockfileEntry };
  const flat: FlatEntry[] = Object.entries(lock.entries).map(([name, entry]) => ({
    name,
    entry,
  }));

  function jarPath(e: FlatEntry): string | undefined {
    const { source, resolvedVersion } = e.entry;
    if (source.kind === "modrinth") {
      return join(
        getCachePath(),
        "dependencies",
        "modrinth",
        source.slug,
        `${resolvedVersion}.jar`,
      );
    }
    if (source.kind === "maven") {
      return join(
        getCachePath(),
        "dependencies",
        "maven",
        source.groupId,
        source.artifactId,
        `${resolvedVersion}.jar`,
      );
    }
    return undefined;
  }

  const tooNew: string[] = [];
  let checked = 0;

  await Promise.all(
    flat.map(async (e) => {
      const path = jarPath(e);
      if (!path || !existsSync(path)) return;
      const classMajor = await readJarClassMajor(path);
      if (classMajor === undefined) return;
      checked++;
      const required = classMajorToJava(classMajor);
      if (required > userJava!) tooNew.push(`${e.name} requires Java ${required}`);
    }),
  );

  if (checked === 0) {
    return {
      id: "dep-jars",
      label: "Dependency compatibility",
      status: "pass",
      detail: "no cached jars to inspect",
    };
  }

  if (tooNew.length > 0) {
    return {
      id: "dep-jars",
      label: "Dependency compatibility",
      status: "warn",
      detail: tooNew.join("; "),
    };
  }

  return {
    id: "dep-jars",
    label: "Dependency compatibility",
    status: "pass",
    detail: `${checked} jar${checked === 1 ? "" : "s"} compatible with Java ${userJava}`,
  };
}

/**
 * Compare the running pluggy version against the latest GitHub release.
 * Uses the cached value when fresh; otherwise fetches with a short
 * timeout so doctor stays responsive even when offline.
 */
export async function checkPluggyVersion(
  currentVersion: string,
  repository: string,
): Promise<CheckResult> {
  if (currentVersion === "0.0.0" || currentVersion === "") {
    return {
      id: "pluggy-version",
      label: "Pluggy version",
      status: "pass",
      detail: "development build",
    };
  }

  let latest = await getCachedLatestVersion();
  if (latest === undefined) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      try {
        const res = await fetch(`https://api.github.com/repos/${repository}/releases/latest`, {
          headers: { Accept: "application/vnd.github+json" },
          signal: controller.signal,
        });
        if (res.ok) {
          const data = (await res.json()) as { tag_name?: string };
          if (typeof data.tag_name === "string") {
            latest = data.tag_name.replace(/^v/, "");
          }
        }
      } finally {
        clearTimeout(timer);
      }
    } catch {
      // Network failure: surface as a soft warn so the user knows we couldn't check.
      return {
        id: "pluggy-version",
        label: "Pluggy version",
        status: "warn",
        detail: `running ${currentVersion}; could not reach GitHub to check for updates`,
      };
    }
  }

  if (latest === undefined) {
    return {
      id: "pluggy-version",
      label: "Pluggy version",
      status: "warn",
      detail: `running ${currentVersion}; could not determine latest release`,
    };
  }

  if (compareVersions(currentVersion, latest) < 0) {
    return {
      id: "pluggy-version",
      label: "Pluggy version",
      status: "warn",
      detail: `running ${currentVersion}; ${latest} is available. Run 'pluggy upgrade'`,
    };
  }

  return {
    id: "pluggy-version",
    label: "Pluggy version",
    status: "pass",
    detail: `${currentVersion} (latest)`,
  };
}

function projectsForValidation(context: WorkspaceContext): ResolvedProject[] {
  const out: ResolvedProject[] = [context.root];
  for (const ws of context.workspaces) {
    out.push(ws.project);
  }
  return out;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function printCheck(c: CheckResult): void {
  const marker = c.status === "pass" ? green("✔") : c.status === "warn" ? yellow("!") : red("✖");
  const detail = c.detail === undefined || c.detail.length === 0 ? "" : `: ${c.detail}`;
  log.info(`  ${marker} ${c.label}${detail}`);
}

// ---------------------------------------------------------------------------
// Human / report rendering
// ---------------------------------------------------------------------------

function printHumanReport(result: DoctorCommandResult): void {
  log.info(bold("pluggy doctor"));

  const env = result.environment;
  log.heading("Environment");
  log.step(`pluggy ${env.pluggy.version}`);
  log.step(`os: ${env.os.platform} ${env.os.release} (${env.os.arch})`);
  log.step(`runtime: ${env.runtime.name} ${env.runtime.version}`);
  log.step(
    `terminal: TTY=${env.terminal.isTTY ? "yes" : "no"}${
      env.terminal.columns !== undefined ? `, ${env.terminal.columns} cols` : ""
    }`,
  );
  if (env.locale !== undefined) log.step(`locale: ${env.locale}`);
  log.step(
    `env vars set: ${env.envVarsSet.length === 0 ? "(none of interest)" : env.envVarsSet.join(", ")}`,
  );
  log.step(`cache: ${env.paths.cache}`);
  log.step(`state: ${env.paths.state}`);
  log.step(`install: ${env.install.label} (${env.install.binaryPath})`);
  if (env.install.otherInstalls.length > 0) {
    log.step(
      `${yellow("⚠")} other pluggy binaries on PATH: ${env.install.otherInstalls.join(", ")}`,
    );
  }

  if (env.project !== undefined) {
    log.heading("Project");
    log.step(`name: ${env.project.name}@${env.project.version}`);
    if (env.project.primaryPlatform !== undefined) {
      log.step(
        `primary: ${env.project.primaryPlatform}${
          env.project.primaryVersion !== undefined ? ` ${env.project.primaryVersion}` : ""
        }`,
      );
    }
    log.step(`workspaces: ${env.project.workspaces}`);
    log.step(`declared dependencies: ${env.project.dependencies}`);
  }

  if (env.lockfile !== undefined) {
    const lf = env.lockfile;
    log.heading("Lockfile");
    log.step(`version: ${lf.version}`);
    log.step(`entries: ${lf.entries} (${lf.topLevel} top-level, ${lf.transitive} transitive)`);
    log.step(`orphans: ${lf.orphans}`);
    if (lf.lastModifiedAt !== undefined) log.step(`last modified: ${lf.lastModifiedAt}`);
  }

  log.heading("Checks");
  for (const c of result.checks) {
    printCheck(c);
  }

  if (result.fixes !== undefined && result.fixes.length > 0) {
    log.heading("Fixes applied");
    for (const f of result.fixes) {
      log.step(`${green("✓")} ${f.detail}`);
    }
  }

  log.info("");
  const { passed, warned, failed } = result.summary;
  const summaryLine = `${passed} passed, ${warned} warned, ${failed} failed`;
  if (failed > 0) {
    log.info(`${red("✗")} ${summaryLine}`);
  } else {
    log.info(`${green("✓")} ${summaryLine}`);
  }
}

/** Build a paste-friendly markdown report for issue filing. */
function renderReport(result: DoctorCommandResult): string {
  const env = result.environment;
  const lines: string[] = [];
  lines.push("<details><summary>pluggy doctor report</summary>");
  lines.push("");

  lines.push("### Environment");
  lines.push("");
  lines.push(`- pluggy: ${env.pluggy.version}`);
  lines.push(`- os: ${env.os.platform} ${env.os.release} (${env.os.arch})`);
  lines.push(`- runtime: ${env.runtime.name} ${env.runtime.version}`);
  const term = `TTY=${env.terminal.isTTY ? "yes" : "no"}${
    env.terminal.columns !== undefined ? `, ${env.terminal.columns} cols` : ""
  }`;
  lines.push(`- terminal: ${term}`);
  if (env.locale !== undefined) lines.push(`- locale: ${env.locale}`);
  lines.push(
    `- env vars set: ${env.envVarsSet.length === 0 ? "(none)" : env.envVarsSet.join(", ")}`,
  );
  lines.push(`- cache: ${env.paths.cache}`);
  lines.push(`- state: ${env.paths.state}`);
  lines.push("");

  if (env.project !== undefined) {
    const p = env.project;
    lines.push("### Project");
    lines.push("");
    lines.push(`- name: ${p.name}`);
    lines.push(`- version: ${p.version}`);
    if (p.primaryPlatform !== undefined) lines.push(`- primary platform: ${p.primaryPlatform}`);
    if (p.primaryVersion !== undefined) lines.push(`- primary version: ${p.primaryVersion}`);
    lines.push(`- workspaces: ${p.workspaces}`);
    lines.push(`- dependencies: ${p.dependencies}`);
    lines.push("");
  }

  if (env.lockfile !== undefined) {
    const lf = env.lockfile;
    lines.push("### Lockfile");
    lines.push("");
    lines.push(`- version: ${lf.version}`);
    lines.push(`- entries: ${lf.entries}`);
    lines.push(`- top-level: ${lf.topLevel}`);
    lines.push(`- transitive: ${lf.transitive}`);
    lines.push(`- orphans: ${lf.orphans}`);
    if (lf.lastModifiedAt !== undefined) lines.push(`- last modified: ${lf.lastModifiedAt}`);
    lines.push("");
  }

  lines.push("### Checks");
  lines.push("");
  lines.push("| Status | Check | Detail |");
  lines.push("| --- | --- | --- |");
  for (const c of result.checks) {
    const tag = c.status === "pass" ? "[ok]" : c.status === "warn" ? "[warn]" : "[fail]";
    lines.push(`| ${tag} | ${escapeCell(c.label)} | ${escapeCell(c.detail ?? "")} |`);
  }
  lines.push("");

  const { passed, warned, failed } = result.summary;
  lines.push(`Summary: ${passed} passed, ${warned} warned, ${failed} failed`);
  lines.push("");
  lines.push("</details>");
  return lines.join("\n");
}

/** Escape a value so it survives a markdown table cell intact. */
function escapeCell(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/** Factory for the `pluggy doctor` commander command. */
export function doctorCommand(options: { pluggyVersion: string; repository: string }): Command {
  return new Command("doctor")
    .description("Check your environment and project for common issues.")
    .option("--report", "Print a paste-friendly markdown report for issue filing.")
    .option(
      "--fix",
      "Apply safe, non-destructive remediations (lockfile prune, missing workspaces).",
    )
    .action(async function action(this: Command, cmdOptions: { report?: boolean; fix?: boolean }) {
      const result = await runDoctorCommand({
        pluggyVersion: options.pluggyVersion,
        repository: options.repository,
        report: cmdOptions.report === true,
        fix: cmdOptions.fix === true,
      });
      if (result.exitCode !== 0) {
        process.exit(result.exitCode);
      }
    });
}
