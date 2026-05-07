/**
 * `pluggy sdk` — the JDK *toolchain* surface. For cross-cutting cache
 * housekeeping (LRU eviction, total size, cleaning everything) see
 * `pluggy cache prune` / `cache info` / `cache clean --category jdk`.
 *
 * Subcommands:
 *   install [<major>]         Download + cache a JDK. With no arg, derives
 *                             the major from the current project.
 *   list                      Show cached JDKs (and on `--available`, what
 *                             majors Disco can serve for this host).
 *   path <major>              Print the absolute javaHome for a cached JDK.
 *   use <major>               Pin a JDK in the current project.json.
 *   remove <major>            Delete a cached JDK.
 *
 * `--distribution` is an opt-in override; defaults to Temurin. Only the
 * curated allowlist is accepted — see `ALLOWED_DISTRIBUTIONS`. Adding
 * distributions later is non-breaking; narrowing isn't.
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
import { bold, dim, green, log, red } from "../logging.ts";

import { ensureJdk, getCachedJdk, listInstalled, removeJdk } from "../sdk/index.ts";
import { selectJdkForProject } from "../sdk/resolve.ts";
import {
  ALLOWED_DISTRIBUTIONS,
  parseDistribution,
  type AllowedDistribution,
} from "../sdk/distributions.ts";

interface SdkGlobalOpts {
  json?: boolean;
  project?: string;
}

/** Top-level `sdk` command. Subcommands attached below. */
export function sdkCommand(): Command {
  const cmd = new Command("sdk").description("Manage JDK toolchains (install, list, pin, remove).");

  cmd.addCommand(installSubcommand());
  cmd.addCommand(listSubcommand());
  cmd.addCommand(pathSubcommand());
  cmd.addCommand(useSubcommand());
  cmd.addCommand(removeSubcommand());

  return cmd;
}

// ---------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------

function installSubcommand(): Command {
  return new Command("install")
    .description("Download and cache a JDK. With no <major>, derives it from project.json.")
    .argument("[major]", "Java major release, e.g. 21.")
    .option("--distribution <name>", "JDK distribution.", parseDistribution, undefined)
    .option("--force", "Reinstall even if already cached. Wipes the slot and re-downloads.")
    .action(async function action(this: Command, majorArg: string | undefined, options) {
      const globalOpts = this.optsWithGlobals() as SdkGlobalOpts;
      const distribution = (options.distribution as AllowedDistribution | undefined) ?? "temurin";

      const major =
        majorArg !== undefined ? parseMajor(majorArg) : await majorFromProject(globalOpts);

      if (options.force === true) {
        await removeJdk(major, distribution);
      }

      // Explicit installs always write to the cache — never accept JAVA_HOME.
      const resolved = await ensureJdk(major, { distribution, ignoreSystemJava: true });

      if (globalOpts.json === true) {
        emitJson({
          status: "success",
          action: "install",
          major: resolved.major,
          distribution: resolved.distribution,
          source: resolved.source,
          javaHome: resolved.javaHome,
          javaPath: resolved.javaPath,
        });
        return;
      }
      if (resolved.source === "cache") {
        log.info(
          `${bold("sdk")} ${distribution} ${major} already installed at ${resolved.javaHome}`,
        );
      } else {
        log.success(`${bold("sdk")} installed ${distribution} ${major} at ${resolved.javaHome}`);
      }
    });
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

function listSubcommand(): Command {
  return new Command("list")
    .alias("ls")
    .description("Show cached JDKs.")
    .option("--available", "Show distributions pluggy will install.")
    .action(async function action(this: Command, options) {
      const globalOpts = this.optsWithGlobals() as SdkGlobalOpts;

      if (options.available === true) {
        if (globalOpts.json === true) {
          emitJson({ status: "success", available: ALLOWED_DISTRIBUTIONS });
          return;
        }
        log.info(bold("Distributions pluggy can install:"));
        for (const d of ALLOWED_DISTRIBUTIONS) log.info(`  ${d}`);
        return;
      }

      const installed = await listInstalled();
      if (globalOpts.json === true) {
        emitJson({ status: "success", installed });
        return;
      }
      if (installed.length === 0) {
        log.info("No cached JDKs. Run `pluggy sdk install <major>` to install one.");
        return;
      }
      log.info(bold("Cached JDKs:"));
      for (const e of installed) {
        const status = e.present ? green("✓") : red("✗");
        const used = formatRelative(e.lastUsed);
        log.info(
          `  ${status} ${e.distribution} ${e.major}  ${dim(`(${e.fullVersion})`)}  ${dim(`last used ${used}`)}`,
        );
      }
    });
}

// ---------------------------------------------------------------------------
// path
// ---------------------------------------------------------------------------

function pathSubcommand(): Command {
  return new Command("path")
    .description("Print JAVA_HOME for a cached JDK. Exits 1 if not installed.")
    .argument("<major>", "Java major release.")
    .option("--distribution <name>", "JDK distribution.", parseDistribution, "temurin")
    .action(async function action(this: Command, majorArg: string, options) {
      const globalOpts = this.optsWithGlobals() as SdkGlobalOpts;
      const major = parseMajor(majorArg);
      const distribution = options.distribution as AllowedDistribution;

      const cached = getCachedJdk(major, distribution);
      if (cached === undefined) {
        if (globalOpts.json === true) {
          emitJson(
            {
              status: "error",
              message: `${distribution} ${major} not installed`,
              exitCode: 1,
            },
            "stderr",
          );
        } else {
          log.error(
            `${distribution} ${major} is not installed. Run: pluggy sdk install ${major}${distribution === "temurin" ? "" : ` --distribution ${distribution}`}`,
          );
        }
        process.exit(1);
      }

      if (globalOpts.json === true) {
        emitJson({
          status: "success",
          major: cached.major,
          distribution: cached.distribution,
          javaHome: cached.javaHome,
          javaPath: cached.javaPath,
        });
      } else {
        process.stdout.write(`${cached.javaHome}\n`);
      }
    });
}

// ---------------------------------------------------------------------------
// use
// ---------------------------------------------------------------------------

function useSubcommand(): Command {
  return new Command("use")
    .description("Pin a JDK in the current project.json so teammates land on the same one.")
    .argument("<major>", "Java major release.")
    .option("--distribution <name>", "JDK distribution.", parseDistribution, undefined)
    .action(async function action(this: Command, majorArg: string, options) {
      const globalOpts = this.optsWithGlobals() as SdkGlobalOpts;
      const major = parseMajor(majorArg);
      const distribution = options.distribution as AllowedDistribution | undefined;

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

      if (globalOpts.json === true) {
        emitJson({ status: "success", action: "use", major, distribution, projectFile: path });
        return;
      }
      log.success(
        `Pinned Java ${major}${distribution !== undefined ? ` (${distribution})` : ""} in ${path}`,
      );
    });
}

// ---------------------------------------------------------------------------
// remove
// ---------------------------------------------------------------------------

function removeSubcommand(): Command {
  return new Command("remove")
    .alias("rm")
    .description("Delete a cached JDK.")
    .argument("<major>", "Java major release.")
    .option("--distribution <name>", "JDK distribution.", parseDistribution, "temurin")
    .action(async function action(this: Command, majorArg: string, options) {
      const globalOpts = this.optsWithGlobals() as SdkGlobalOpts;
      const major = parseMajor(majorArg);
      const distribution = options.distribution as AllowedDistribution;

      const removed = await removeJdk(major, distribution);

      if (globalOpts.json === true) {
        emitJson({ status: "success", action: "remove", removed, major, distribution });
        return;
      }
      if (removed) {
        log.success(`Removed ${distribution} ${major}`);
      } else {
        log.warn(`${distribution} ${major} was not installed`);
      }
    });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseMajor(value: string): number {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n) || n < 6 || n > 99) {
    throw new InvalidArgumentError(`"${value}" is not a valid Java major release`);
  }
  return n;
}

function loadProject(globalOpts: SdkGlobalOpts): ResolvedProject {
  const fromFile =
    globalOpts.project !== undefined ? resolveProjectFile(globalOpts.project) : undefined;
  const project = fromFile ?? getCurrentProject();
  if (project === undefined) {
    throw new Error("sdk: no project.json found — run from inside a pluggy project");
  }
  return project;
}

async function majorFromProject(globalOpts: SdkGlobalOpts): Promise<number> {
  const project = loadProject(globalOpts);
  const selection = await selectJdkForProject(project);
  return selection.major;
}

function emitJson(payload: unknown, target: "stdout" | "stderr" = "stdout"): void {
  const stream = target === "stderr" ? process.stderr : process.stdout;
  stream.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function formatRelative(epochMs: number): string {
  const diff = Date.now() - epochMs;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}
