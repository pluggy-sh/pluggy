import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";

import { Command } from "commander";

import { pickDescriptor } from "../build/descriptor.ts";
import { HOTSWAP_AGENT_VERSION } from "../dev/hotswap.ts";
import { JBR_VERSION, jbrCacheKey, jbrJavaPath, jbrTarget } from "../dev/jbr.ts";
import { classMajorToJava, readJarClassMajor, readManifestAttribute } from "../jar.ts";
import { type LockfileEntry, type TransitiveEntry, readLock } from "../lockfile.ts";
import { bold, green, log, red, yellow } from "../logging.ts";
import { getPlatform, getRegisteredPlatforms } from "../platform/index.ts";
import { getCachePath, type ResolvedProject } from "../project.ts";
import { registryUrl } from "../registry.ts";
import { getLatestModrinthVersion } from "../resolver/modrinth.ts";
import { getCachedJdk } from "../sdk/index.ts";
import { selectJdkForProject } from "../sdk/resolve.ts";
import { compareVersions, getCachedLatestVersion } from "../update-check.ts";
import { resolveWorkspaceContext, topologicalOrder, type WorkspaceContext } from "../workspace.ts";

export type CheckStatus = "pass" | "warn" | "fail";

export interface CheckResult {
  id: string;
  label: string;
  status: CheckStatus;
  detail?: string;
}

export interface DoctorCommandOptions {
  json?: boolean;
  cwd?: string;
  /** Current pluggy CLI version (without leading `v`). Used by the `pluggy-version` check. */
  pluggyVersion?: string;
  /** GitHub `owner/repo` slug used by the `pluggy-version` check. */
  repository?: string;
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
    outdated?: () => Promise<CheckResult>;
    dependencyJars?: () => Promise<CheckResult>;
    pluggyVersion?: () => Promise<CheckResult>;
  };
}

export interface DoctorCommandResult {
  ok: boolean;
  exitCode: 0 | 1;
  checks: CheckResult[];
}

/**
 * Run every environment and project-validation check, returning the
 * aggregated verdict. `exitCode` is 1 iff any check has `status: "fail"` —
 * warns are informational only.
 */
export async function runDoctorCommand(
  opts: DoctorCommandOptions = {},
): Promise<DoctorCommandResult> {
  const cwd = opts.cwd ?? process.cwd();
  const context = resolveWorkspaceContext(cwd);
  if (context === undefined) {
    throw new Error("No pluggy project found — run doctor from inside a project directory.");
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

  const hardFailures = all.filter((c) => c.status === "fail");
  const ok = hardFailures.length === 0;
  const exitCode: 0 | 1 = ok ? 0 : 1;

  if (opts.json === true) {
    const payload = {
      status: ok ? "success" : "error",
      ok,
      checks: all,
      failures: hardFailures,
    };
    if (ok) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.error(JSON.stringify(payload, null, 2));
    }
  } else {
    log.info(bold("pluggy doctor"));
    for (const c of all) {
      printCheck(c);
    }
    log.info("");
    if (ok) {
      log.success("all required checks passed");
    } else {
      log.error(`${hardFailures.length} check(s) failed`);
    }
  }

  return { ok, exitCode, checks: all };
}

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
  const primaryPlatform = target.compatibility?.platforms?.[0];

  if (primaryPlatform === "spigot" || primaryPlatform === "bukkit") {
    const buildToolsPath = join(getCachePath(), "BuildTools.jar");
    const jdkSpec = await readManifestAttribute(buildToolsPath, "Build-Jdk-Spec");
    const minJava = jdkSpec !== undefined ? Number.parseInt(jdkSpec, 10) : 8;
    if (!Number.isNaN(minJava) && userJava < minJava) {
      return {
        id: "java",
        label: "Java toolchain",
        status: "warn",
        detail: `${detail} — BuildTools requires Java ${minJava}+`,
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
 *   pass — the slot is cached or JAVA_HOME points at the right major.
 *   warn — the slot is missing but auto-install is enabled, so the next
 *          build will fetch it. Still actionable for users on slow networks.
 *   fail — the slot is missing and `PLUGGY_NO_AUTO_INSTALL=1` is set, so
 *          the next build would fail. Includes the remediation command.
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
      detail: `${selection.distribution} ${selection.major} not installed and PLUGGY_NO_AUTO_INSTALL=1 — run: ${remedy}`,
    };
  }

  return {
    id: "sdk",
    label: "Project JDK",
    status: "warn",
    detail: `${selection.distribution} ${selection.major} not yet installed — pluggy will fetch on first build. Pre-install: ${remedy}`,
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
 * rather than a failure — we surface it so users know what the first dev
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
          // unreadable entry
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
    if (!getRegisteredPlatforms().includes(p)) {
      return {
        id: "project",
        label,
        status: "fail",
        detail: `unknown platform "${p}" (known: ${getRegisteredPlatforms().join(", ")})`,
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
  const { versions, platforms } = project.compatibility ?? {};
  if (!versions?.length || !platforms?.length) return [];

  const out: CheckResult[] = [];
  for (const platform of platforms) {
    let available: string[];
    try {
      available = await getPlatform(platform).getVersions();
    } catch {
      out.push({
        id: "version-compat",
        label: `Version compatibility (${platform})`,
        status: "warn",
        detail: `could not fetch version list for ${platform}`,
      });
      continue;
    }
    const set = new Set(available);
    const missing = versions.filter((v) => !set.has(v));
    if (missing.length > 0) {
      out.push({
        id: "version-compat",
        label: `Version compatibility (${platform})`,
        status: "fail",
        detail: `${platform} does not publish version${missing.length > 1 ? "s" : ""} ${missing.join(", ")}`,
      });
    } else {
      out.push({
        id: "version-compat",
        label: `Version compatibility (${platform})`,
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
        detail: `${project.compatibility.platforms[0]} → ${desc.path}`,
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

  type FlatEntry = { name: string; entry: LockfileEntry | TransitiveEntry };
  const flat: FlatEntry[] = [];

  function collect(name: string, entry: LockfileEntry | TransitiveEntry): void {
    flat.push({ name, entry });
    for (const t of entry.transitives ?? []) {
      const tName =
        t.source.kind === "maven"
          ? `${t.source.groupId}:${t.source.artifactId}`
          : t.source.kind === "modrinth"
            ? t.source.slug
            : "unknown";
      collect(tName, t);
    }
  }
  for (const [name, entry] of Object.entries(lock.entries)) collect(name, entry);

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
      // Network failure — surface as a soft warn so the user knows we couldn't check.
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
      detail: `running ${currentVersion}; ${latest} is available — run 'pluggy upgrade'`,
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
  const detail = c.detail === undefined || c.detail.length === 0 ? "" : ` — ${c.detail}`;
  log.info(`  ${marker} ${c.label}${detail}`);
}

/** Factory for the `pluggy doctor` commander command. */
export function doctorCommand(options: { pluggyVersion: string; repository: string }): Command {
  return new Command("doctor")
    .description("Check your environment and project for common issues.")
    .action(async function action(this: Command) {
      const globalOpts = this.optsWithGlobals();
      const result = await runDoctorCommand({
        json: globalOpts.json === true,
        pluggyVersion: options.pluggyVersion,
        repository: options.repository,
      });
      if (result.exitCode !== 0) {
        process.exit(result.exitCode);
      }
    });
}
