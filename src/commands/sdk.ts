/**
 * `pluggy sdk`: the JDK *toolchain* surface. For cross-cutting cache
 * housekeeping (LRU eviction, total size, cleaning everything) see
 * `pluggy cache prune` / `cache info` / `cache clean --category jdk`.
 *
 * Subcommands:
 *   info [<distribution>]     What can be installed here, and what this
 *                             project will use (and why).
 *   install [<coordinate>]    Download + cache a JDK. With no arg, derives
 *                             the major from the current project.
 *   list                      Show cached JDKs. Default when `sdk` is bare.
 *   path <coordinate>         Print the absolute javaHome for a cached JDK.
 *   use <coordinate>          Pin a JDK in the current project.json.
 *   remove <coordinate>       Delete a cached JDK.
 *
 * A coordinate is `<major>` or `<distribution>@<major>`, mirroring the
 * `<name>@<version>` grammar `pluggy install` already uses for dependencies.
 * Only the curated allowlist of distributions is accepted (see
 * `ALLOWED_DISTRIBUTIONS`). Adding distributions later is non-breaking;
 * narrowing isn't.
 */

import { readFile } from "node:fs/promises";
import process from "node:process";

import { Command, InvalidArgumentError } from "commander";

import { writeFileLF } from "../portable.ts";
import {
  getCurrentProject,
  resolveProjectFile,
  type Project,
  type ResolvedProject,
} from "../project.ts";
import { bold, dim, emit, emitErr, green, log, red } from "../logging.ts";

import { dirSize, formatBytes } from "../cache/index.ts";
import { jdkCacheRoot } from "../sdk/cache.ts";
import { listAvailableReleases, targetForHost } from "../sdk/disco.ts";
import { ensureJdk, getCachedJdk, listInstalled, removeJdk } from "../sdk/index.ts";
import { selectJdkForProject, type ProjectJdkSelection } from "../sdk/resolve.ts";
import {
  ALLOWED_DISTRIBUTIONS,
  parseDistribution,
  type AllowedDistribution,
} from "../sdk/distributions.ts";

interface SdkGlobalOpts {
  project?: string;
}

/** Top-level `sdk` command. Subcommands attached below. */
export function sdkCommand(): Command {
  const cmd = new Command("sdk").description(
    "Manage JDK toolchains (see what's available, install, pin, remove).",
  );

  cmd.addCommand(infoSubcommand());
  cmd.addCommand(installSubcommand());
  cmd.addCommand(listSubcommand());
  cmd.addCommand(outdatedSubcommand());
  cmd.addCommand(pathSubcommand());
  cmd.addCommand(useSubcommand());
  cmd.addCommand(removeSubcommand());

  // Bare `pluggy sdk` shows what's installed rather than printing help, the
  // same way bare `pluggy cache` shows `cache info`.
  cmd.action(async function action(this: Command) {
    await renderCachedJdks();
  });

  return cmd;
}

// ---------------------------------------------------------------------------
// info
// ---------------------------------------------------------------------------

function infoSubcommand(): Command {
  return new Command("info")
    .description(
      "Show which JDKs can be installed on this machine, and which one this project uses.",
    )
    .argument("[distribution]", "Limit to one distribution and list its full versions.")
    .addHelpText(
      "after",
      `\nExamples:\n  $ pluggy sdk info\n  $ pluggy sdk info temurin\n\nAvailability is queried per host: a distribution may publish a major for Linux\nbut not for this machine's OS and architecture.`,
    )
    .action(async function action(this: Command, distributionArg: string | undefined) {
      const globalOpts = this.optsWithGlobals() as SdkGlobalOpts;
      const host = targetForHost();
      const selection = await projectSelection(globalOpts);
      const installed = await listInstalled();

      if (distributionArg !== undefined) {
        const distribution = parseDistribution(distributionArg);
        const releases = await listAvailableReleases(distribution);
        const cached = installed.filter((e) => e.distribution === distribution && e.present);
        emit(
          {
            status: "success",
            distribution,
            host,
            available: releases,
            cached: cached.map((c) => ({ major: c.major, fullVersion: c.fullVersion })),
            project: selection,
          },
          () => {
            log.heading(distribution);
            log.info(
              `  ${dim(`available for ${host.os}/${host.arch}:`)}  ${
                releases.length === 0 ? "(none)" : releases.map((r) => r.fullVersion).join(", ")
              }`,
            );
            log.info(
              `  ${dim("cached:")}                       ${
                cached.length === 0 ? "(none)" : cached.map((c) => c.fullVersion).join(", ")
              }`,
            );
            if (selection !== undefined && selection.distribution === distribution) {
              log.info(`  ${dim("used by this project:")}         ${selection.major}`);
            }
            log.info("");
            const example = releases[0]?.major ?? 21;
            log.info(dim(`Install: pluggy sdk install ${distribution}@${example}`));
          },
        );
        return;
      }

      const rows = await Promise.all(
        ALLOWED_DISTRIBUTIONS.map(async (distribution) => {
          try {
            const releases = await listAvailableReleases(distribution);
            return { distribution, majors: releases.map((r) => r.major) };
          } catch {
            // One unreachable distribution shouldn't blank the whole table.
            return { distribution, majors: undefined };
          }
        }),
      );

      emit({ status: "success", host, distributions: rows, project: selection }, () => {
        log.heading(`Distributions installable on ${host.os}/${host.arch}`);
        const width = Math.max(...ALLOWED_DISTRIBUTIONS.map((d) => d.length));
        for (const row of rows) {
          const label = row.distribution.padEnd(width);
          const majors =
            row.majors === undefined
              ? dim("(unavailable)")
              : row.majors.length === 0
                ? dim("(none)")
                : row.majors.join(", ");
          const marker = row.distribution === "temurin" ? dim(" (default)") : "";
          log.info(`  ${label}  ${majors}${marker}`);
        }
        log.info("");
        if (selection === undefined) {
          log.info(dim("Run inside a project to see which JDK it uses."));
        } else {
          log.info(
            `This project uses ${bold(`${selection.distribution} ${selection.major}`)} — ${explainSelection(selection)}.`,
          );
          log.info(dim("Pin a different one: pluggy sdk use <distribution>@<major>"));
        }
      });
    });
}

/** Plain-English rendering of where the project's Java major came from. */
function explainSelection(selection: ProjectJdkSelection): string {
  switch (selection.source) {
    case "project-pin":
      return "pinned by the `jdk` block in project.json";
    case "spigot-manifest":
      return "required by the Minecraft version's build manifest";
    case "fallback-table":
      return "derived from the project's Minecraft version";
    case "fallback-default":
      return "pluggy's default, since the Minecraft version implies nothing";
  }
}

// ---------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------

function installSubcommand(): Command {
  return new Command("install")
    .description("Download and cache a JDK. With no argument, derives it from project.json.")
    .argument("[coordinate]", "`<major>` or `<distribution>@<major>`, e.g. 21 or temurin@21.")
    .option("--force", "Reinstall even if already cached.")
    .addHelpText(
      "after",
      "\nExamples:\n  $ pluggy sdk install\n  $ pluggy sdk install 21\n  $ pluggy sdk install temurin@21\n\nRun `pluggy sdk info` to see what's installable here.",
    )
    .action(async function action(this: Command, coordinate: string | undefined, options) {
      const globalOpts = this.optsWithGlobals() as SdkGlobalOpts;
      const parsed =
        coordinate !== undefined
          ? parseCoordinate(coordinate)
          : { major: await majorFromProject(globalOpts), distribution: undefined };
      const distribution = parsed.distribution ?? "temurin";

      // Explicit installs always write to the cache; never accept JAVA_HOME.
      const resolved = await ensureJdk(parsed.major, {
        distribution,
        ignoreSystemJava: true,
        force: options.force === true,
      });

      emit(
        {
          status: "success",
          action: "install",
          major: resolved.major,
          distribution: resolved.distribution,
          source: resolved.source,
          javaHome: resolved.javaHome,
          javaPath: resolved.javaPath,
        },
        () => {
          if (resolved.source === "cache") {
            log.info(
              `${bold("sdk")} ${distribution} ${resolved.major} already installed at ${resolved.javaHome}`,
            );
          } else {
            log.success(
              `${bold("sdk")} installed ${distribution} ${resolved.major} at ${resolved.javaHome}`,
            );
          }
        },
      );
    });
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

function listSubcommand(): Command {
  return new Command("list")
    .alias("ls")
    .description("Show cached JDKs.")
    .action(async function action() {
      await renderCachedJdks();
    });
}

async function renderCachedJdks(): Promise<void> {
  const installed = await listInstalled();
  const rows = await Promise.all(
    installed.map(async (e) => ({
      ...e,
      sizeBytes: e.present ? await dirSize(e.slotPath) : 0,
    })),
  );
  const cachePath = jdkCacheRoot();
  emit({ status: "success", installed: rows, cachePath }, () => {
    if (rows.length === 0) {
      log.info("No cached JDKs.");
      log.info(dim("See what's installable: pluggy sdk info"));
      return;
    }
    log.info(bold("Cached JDKs:"));
    for (const e of rows) {
      const status = e.present ? green("✓") : red("✗");
      const used = formatRelative(e.lastUsed);
      log.info(
        `  ${status} ${e.distribution} ${e.major}  ${dim(`(${e.fullVersion})`)}  ${formatBytes(e.sizeBytes)}  ${dim(`last used ${used}`)}`,
      );
    }
    log.info("");
    log.info(dim(`stored under ${cachePath} — manage with \`pluggy cache\``));
  });
}

// ---------------------------------------------------------------------------
// outdated
// ---------------------------------------------------------------------------

/**
 * The JDK analogue of `pluggy outdated`. A cached JDK's `fullVersion` was
 * shown by `sdk list` but never compared against upstream, so the only way to
 * refresh one was a blind `sdk install --force`.
 */
function outdatedSubcommand(): Command {
  return new Command("outdated")
    .description("Show cached JDKs that have a newer build upstream.")
    .action(async function action() {
      const installed = (await listInstalled()).filter((e) => e.present);
      const rows = await Promise.all(
        installed.map(async (entry) => {
          try {
            const releases = await listAvailableReleases(entry.distribution);
            const latest = releases.find((r) => r.major === entry.major)?.fullVersion;
            return {
              ...entry,
              latest,
              stale: latest !== undefined && latest !== entry.fullVersion,
            };
          } catch {
            return { ...entry, latest: undefined, stale: false };
          }
        }),
      );
      const stale = rows.filter((r) => r.stale);

      emit(
        {
          status: "success",
          outdated: stale.map((r) => ({
            distribution: r.distribution,
            major: r.major,
            current: r.fullVersion,
            latest: r.latest,
          })),
        },
        () => {
          if (installed.length === 0) {
            log.info("No cached JDKs.");
            log.info(dim("See what's installable: pluggy sdk info"));
            return;
          }
          if (stale.length === 0) {
            log.success(`All ${installed.length} cached JDKs are current.`);
            return;
          }
          log.heading("Outdated");
          for (const row of stale) {
            log.info(
              `  ${bold(`${row.distribution} ${row.major}`)}  ${row.fullVersion} ${dim("→")} ${row.latest}`,
            );
          }
          log.info("");
          log.info(
            dim(`Update: pluggy sdk install ${stale[0]?.distribution}@${stale[0]?.major} --force`),
          );
        },
      );
    });
}

// ---------------------------------------------------------------------------
// path
// ---------------------------------------------------------------------------

function pathSubcommand(): Command {
  return new Command("path")
    .description("Print JAVA_HOME for a cached JDK. Exits 1 if not installed.")
    .argument("<coordinate>", "`<major>` or `<distribution>@<major>`.")
    .action(async function action(this: Command, coordinate: string) {
      const { major, distribution: parsed } = parseCoordinate(coordinate);
      const distribution = parsed ?? "temurin";

      const cached = getCachedJdk(major, distribution);
      if (cached === undefined) {
        emitErr(
          { status: "error", message: `${distribution} ${major} not installed`, exitCode: 1 },
          () => {
            log.error(
              `${distribution} ${major} is not installed. Run: pluggy sdk install ${distribution}@${major}`,
            );
          },
        );
        process.exit(1);
      }

      emit(
        {
          status: "success",
          major: cached.major,
          distribution: cached.distribution,
          javaHome: cached.javaHome,
          javaPath: cached.javaPath,
        },
        () => {
          process.stdout.write(`${cached.javaHome}\n`);
        },
      );
    });
}

// ---------------------------------------------------------------------------
// use
// ---------------------------------------------------------------------------

function useSubcommand(): Command {
  return new Command("use")
    .description("Pin a JDK in the current project.json so teammates land on the same one.")
    .argument("<coordinate>", "`<major>` or `<distribution>@<major>`.")
    .action(async function action(this: Command, coordinate: string) {
      const globalOpts = this.optsWithGlobals() as SdkGlobalOpts;
      const { major, distribution } = parseCoordinate(coordinate);

      const project = loadProject(globalOpts);

      const path = project.projectFile;
      const raw = await readFile(path, "utf8");
      const parsed = JSON.parse(raw) as Project;
      parsed.jdk = {
        ...parsed.jdk,
        major,
        ...(distribution !== undefined ? { distribution } : {}),
      };
      await writeFileLF(path, `${JSON.stringify(parsed, null, 2)}\n`);

      emit({ status: "success", action: "use", major, distribution, projectFile: path }, () => {
        log.success(
          `Pinned Java ${major}${distribution !== undefined ? ` (${distribution})` : ""} in ${path}`,
        );
      });
    });
}

// ---------------------------------------------------------------------------
// remove
// ---------------------------------------------------------------------------

function removeSubcommand(): Command {
  return new Command("remove")
    .alias("rm")
    .description("Delete a cached JDK.")
    .argument("<coordinate>", "`<major>` or `<distribution>@<major>`.")
    .action(async function action(this: Command, coordinate: string) {
      const { major, distribution: parsed } = parseCoordinate(coordinate);
      const distribution = parsed ?? "temurin";

      const result = await removeJdk(major, distribution);

      emit(
        {
          status: "success",
          action: "remove",
          removed: result.removed,
          major,
          distribution,
          slotPath: result.slotPath,
          freedBytes: result.freedBytes,
        },
        () => {
          if (result.removed) {
            log.success(
              `Removed ${distribution} ${major} (freed ${formatBytes(result.freedBytes)}) from ${result.slotPath}`,
            );
          } else {
            log.warn(`${distribution} ${major} was not installed`);
          }
        },
      );
    });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseMajor(value: string): number {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n) || String(n) !== value.trim() || n < 6 || n > 99) {
    throw new InvalidArgumentError(
      `"${value}" is not a Java major release. Run \`pluggy sdk info\` to see what's installable.`,
    );
  }
  return n;
}

/**
 * Parse `<major>` or `<distribution>@<major>`, the same `name@version` shape
 * `pluggy install` uses for dependencies.
 *
 * This replaced a two-positional overload disambiguated by argument *count*,
 * which meant a lone `pluggy sdk install temurin` was parsed as a major and
 * rejected with `"temurin" is not a valid Java major release` — for a value
 * the help text invited.
 */
export function parseCoordinate(value: string): {
  major: number;
  distribution: AllowedDistribution | undefined;
} {
  const at = value.indexOf("@");
  if (at === -1) {
    if ((ALLOWED_DISTRIBUTIONS as readonly string[]).includes(value)) {
      throw new InvalidArgumentError(
        `"${value}" is a distribution, not a version. Add a major, e.g. ${value}@21 — or run \`pluggy sdk info ${value}\` to see what's available.`,
      );
    }
    return { major: parseMajor(value), distribution: undefined };
  }
  return {
    distribution: parseDistribution(value.slice(0, at)),
    major: parseMajor(value.slice(at + 1)),
  };
}

function loadProject(globalOpts: SdkGlobalOpts): ResolvedProject {
  const fromFile =
    globalOpts.project !== undefined ? resolveProjectFile(globalOpts.project) : undefined;
  const project = fromFile ?? getCurrentProject();
  if (project === undefined) {
    throw new Error("sdk: no project.json found. Run from inside a pluggy project");
  }
  return project;
}

/** The project's JDK selection, or `undefined` outside a project. */
async function projectSelection(
  globalOpts: SdkGlobalOpts,
): Promise<ProjectJdkSelection | undefined> {
  const fromFile =
    globalOpts.project !== undefined ? resolveProjectFile(globalOpts.project) : undefined;
  const project = fromFile ?? getCurrentProject();
  if (project === undefined) return undefined;
  return selectJdkForProject(project);
}

async function majorFromProject(globalOpts: SdkGlobalOpts): Promise<number> {
  const project = loadProject(globalOpts);
  const selection = await selectJdkForProject(project);
  return selection.major;
}

function formatRelative(epochMs: number): string {
  const diff = Date.now() - epochMs;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}
