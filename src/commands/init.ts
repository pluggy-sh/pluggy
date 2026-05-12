import { readdir } from "node:fs/promises";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import process from "node:process";

import { Command, InvalidArgumentError } from "commander";
import { checkbox, confirm, input, select } from "@inquirer/prompts";

import defaultConfig from "../defaults/config.yml" with { type: "text" };
import bukkitPackage from "../defaults/bukkit-package.java" with { type: "text" };
import velocityPackage from "../defaults/velocity-package.java" with { type: "text" };
import bungeePackage from "../defaults/bungee-package.java" with { type: "text" };
import spongePackage from "../defaults/sponge-package.java" with { type: "text" };

import { writeIntellijStub } from "../build/intellij.ts";
import { platforms, type PlatformFamily } from "../platform/index.ts";
import { deriveVelocityId } from "../platform/descriptor/velocity.ts";
import { deriveSpongeId } from "../platform/descriptor/sponge.ts";
import { bold, dim, emit, isJsonMode, log } from "../logging.ts";
import { safeJoin, writeFileLF } from "../portable.ts";
import {
  getCurrentProject,
  primaryPlatform,
  type Project,
  resolveProjectFile,
} from "../project.ts";
import { replace } from "../template.ts";
import {
  getTemplateMetadata,
  listTemplates,
  loadTemplate,
  type InstantiatedTemplate,
  type TemplateFile,
  type TemplateMetadata,
} from "../templates/index.ts";

import { parseMcVersion, parsePlatform, parseSemver } from "./parsers.ts";

/** Optional inputs to {@link generateProject}. */
export interface GenerateProjectOptions {
  /**
   * Files contributed by a template. When present, these replace the
   * embedded `src/<package>/<Class>.java` + `src/config.yml` baseline.
   * Each path is POSIX-form, relative to the project root, with all
   * `__placeholder__` and `${...}` substitution already applied.
   */
  templateFiles?: TemplateFile[];
}

/**
 * Scaffold a new project at `distDir` from the given `Project` config.
 *
 * Writes:
 *   - `project.json`
 *   - either `templateFiles` from `options`, or the embedded stub:
 *     `src/<package>/<Class>.java` matching the project's platform family
 *     (bukkit / velocity / bungee) plus `src/config.yml`.
 *   - `.gitignore` (build outputs and regenerated IDE files)
 *   - `<name>.iml` + `.idea/` (IntelliJ stub linked to Eclipse files)
 *
 * Throws if `project.main` is unset, the platform family is unknown, or any
 * of the writes fail.
 */
export async function generateProject(
  distDir: string,
  project: Project,
  options: GenerateProjectOptions = {},
): Promise<void> {
  const main = project.main;
  // A "workspace root" project declares `workspaces` and has no `main` of
  // its own — it isn't a shipping plugin, just an umbrella over child
  // workspaces. Skip the `main`/`primaryPlatform` requirements in that
  // case; the children carry those fields individually.
  const isWorkspaceRoot =
    Array.isArray(project.workspaces) && project.workspaces.length > 0 && !main;
  if (!main && !isWorkspaceRoot) {
    throw new Error("generateProject requires project.main to be set");
  }

  const family = isWorkspaceRoot
    ? undefined
    : platforms.get(primaryPlatform(project)).descriptor.family;

  try {
    await mkdir(distDir, { recursive: true });
  } catch (e) {
    throw new Error(`Failed to create project directory: ${(e as Error).message}`);
  }

  const projectFilePath = join(distDir, "project.json");
  try {
    await writeFile(projectFilePath, JSON.stringify(project, null, 2));
  } catch (e) {
    throw new Error(`Failed to write project file: ${(e as Error).message}`);
  }

  if (options.templateFiles && options.templateFiles.length > 0) {
    for (const file of options.templateFiles) {
      let abs: string;
      try {
        abs = safeJoin(distDir, file.path);
      } catch (e) {
        throw new Error(`Refusing to write template entry ${file.path}: ${(e as Error).message}`);
      }
      try {
        await mkdir(dirname(abs), { recursive: true });
        await writeFileLF(abs, file.content);
      } catch (e) {
        throw new Error(`Failed to write ${file.path}: ${(e as Error).message}`);
      }
    }
  } else if (!isWorkspaceRoot && main !== undefined && family !== undefined) {
    const replacementProject = {
      project: {
        ...project,
        className: main.split(".").pop() || "Main",
        packageName: main.split(".").slice(0, -1).join("."),
        velocityId: deriveVelocityId(project.name),
        spongeId: deriveSpongeId(project.name),
      },
    };

    const configFilePath = join(distDir, "src", "config.yml");
    try {
      await mkdir(join(distDir, "src"), { recursive: true });
      await writeFile(configFilePath, replace(defaultConfig, replacementProject));
    } catch (e) {
      throw new Error(`Failed to write config file: ${(e as Error).message}`);
    }

    const mainClassPath = join(distDir, "src", main.replace(/\./g, "/") + ".java");
    try {
      await mkdir(join(distDir, "src", ...main.split(".").slice(0, -1)), { recursive: true });
      await writeFile(mainClassPath, replace(stubForFamily(family), replacementProject));
    } catch (e) {
      throw new Error(`Failed to write main class file: ${(e as Error).message}`);
    }
  }

  // Default `.gitignore`. `.classpath` and `.project` are regenerated by
  // every build with absolute paths to the user's local cache, so committing
  // them poisons collaborators' clones with `/Users/<me>/...` references.
  // Same logic for build outputs and IntelliJ per-machine state.
  try {
    await writeFileLF(
      join(distDir, ".gitignore"),
      [
        "# pluggy build outputs",
        ".pluggy-build/",
        "bin/",
        "",
        "# Regenerated by `pluggy build`; contain machine-local paths",
        ".classpath",
        ".project",
        "",
      ].join("\n"),
    );
  } catch (e) {
    throw new Error(`Failed to write .gitignore: ${(e as Error).message}`);
  }

  // IntelliJ stub: lets users open the folder directly in IntelliJ without
  // running the Eclipse import wizard or remembering to tick "Link to Eclipse
  // files". Other IDEs ignore `.idea/` and `<name>.iml` entirely.
  try {
    await writeIntellijStub(distDir, project);
  } catch (e) {
    throw new Error(`Failed to write IntelliJ stub: ${(e as Error).message}`);
  }
}

/**
 * Pick the embedded `.java` stub that compiles against `family`. Used as the
 * baseline scaffold when the user doesn't pick a richer template. Keeps
 * `init` working offline.
 */
function stubForFamily(family: PlatformFamily): string {
  if (family === "bukkit") return bukkitPackage;
  if (family === "velocity") return velocityPackage;
  if (family === "bungee") return bungeePackage;
  if (family === "sponge") return spongePackage;
  // exhaustiveness: TS narrowed `family` to `never` if all branches handled.
  const _exhaustive: never = family;
  throw new Error(`No stub for platform family: ${String(_exhaustive)}`);
}

function deriveClassName(name: string): string {
  return name
    .split(/[-_]/)
    .map((part) => (part ? part.charAt(0).toUpperCase() + part.slice(1) : ""))
    .join("");
}

/**
 * Derive `api-version` from a full Minecraft version: `1.21.8` → `1.21`.
 * Used to interpolate `${project.apiVersion}` into template extras (e.g.
 * the MockBukkit artifact id `mockbukkit-v1.21`).
 */
function deriveApiVersion(version: string | undefined): string | undefined {
  if (!version) return undefined;
  const parts = version.split(".");
  if (parts.length < 2) return undefined;
  const [major, minor] = parts;
  if (!/^\d+$/.test(major) || !/^\d+$/.test(minor)) return undefined;
  return `${major}.${minor}`;
}

/**
 * Recursive merge of `extras` into `target`. Plain-object keys merge
 * recursively; everything else (arrays, scalars) replaces. Used to fold a
 * template's `projectJsonExtras` into the generated `project.json`.
 */
function deepMerge<T extends Record<string, unknown>>(
  target: T,
  extras: Record<string, unknown>,
): T {
  const out: Record<string, unknown> = { ...target };
  for (const [key, value] of Object.entries(extras)) {
    const existing = out[key];
    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      existing !== null &&
      typeof existing === "object" &&
      !Array.isArray(existing)
    ) {
      out[key] = deepMerge(existing as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      out[key] = value;
    }
  }
  return out as T;
}

/** Factory for the `pluggy init` commander command. */
export function initCommand(): Command {
  return new Command("init")
    .description(
      "Initialize a new project with interactive prompts.\n\nIf you want to skip prompts and use defaults, use the -y option.\nIt's recommended to use --main <main> to specify the main class name.",
    )
    .argument("[path]", "Target directory for the new project.")
    .option("--name <name>", "Project name.")
    .option("--version <version>", "Project version.", parseSemver)
    .option("--description <description>", "Project description.")
    .option("--main <main>", "Main class name.")
    .option(
      "--platform <platform>",
      "Target platform, repeatable (default: paper).",
      (val: string, prev: string[]) => {
        const id = parsePlatform(val);
        return prev.includes(id) ? prev : [...prev, id];
      },
      [] as string[],
    )
    .option("--mc-version <version>", "Minecraft version for compatibility.", parseMcVersion)
    .option(
      "--template <id>",
      "Scaffold from a template (`pluggy init --template paper-mockbukkit`). Without this flag init uses an embedded family stub and never touches the network.",
    )
    .option("-y, --yes", "Skip prompts and use defaults.")
    .addHelpText(
      "after",
      `\nExamples:\n  $ pluggy init --platform paper --platform velocity\n  $ pluggy init --platform spigot --mc-version 1.21.8\n  $ pluggy init --template paper-mockbukkit`,
    )
    .action(async function action(this: Command, path: string | undefined, options) {
      const globalOpts = this.optsWithGlobals();
      const jsonMode = isJsonMode();
      const interactive = !options.yes && !jsonMode && process.stdout.isTTY;

      let currentProject = getCurrentProject();
      if (globalOpts.project) {
        currentProject = resolveProjectFile(globalOpts.project);
        if (!currentProject) throw new Error(`Project file not found at ${globalOpts.project}`);
      }

      const TARGET_PATH = resolve(process.cwd(), path || ".");

      let warned = false;
      try {
        const entries = await readdir(TARGET_PATH);
        if (entries.length > 0) warned = true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      if (!warned && currentProject) warned = true;

      if (warned && jsonMode && !options.yes) {
        const reason = currentProject
          ? `"${relative(process.cwd(), currentProject.projectFile)}" already exists`
          : `"${TARGET_PATH}" is not empty`;
        throw new Error(`${reason}. Use --yes to overwrite.`);
      }

      if (warned && interactive) {
        const message = currentProject
          ? `"${relative(process.cwd(), currentProject.projectFile)}" already exists. Overwrite?`
          : `"${TARGET_PATH}" is not empty. Continue?`;
        const ok = await confirm({ message, default: false });
        if (!ok) {
          log.info("Aborted.");
          return;
        }
      }

      // Name
      const defaultName = basename(TARGET_PATH);
      const projectName =
        options.name ??
        (path
          ? basename(TARGET_PATH)
          : interactive
            ? await input({ message: "Project name", default: defaultName })
            : defaultName);

      if (!/^[a-zA-Z0-9_-]+$/.test(projectName)) {
        throw new InvalidArgumentError(
          `Invalid project name: "${projectName}". Only alphanumeric characters, underscores, and hyphens are allowed.`,
        );
      }

      // Platforms
      const registeredPlatforms = platforms.list();
      const selectedPlatforms: string[] =
        options.platform.length > 0
          ? options.platform
          : interactive
            ? await checkbox({
                message: "Target platforms",
                choices: registeredPlatforms.map((p) => ({
                  value: p,
                  name: p,
                  checked: p === "paper",
                })),
                validate: (vals) => vals.length > 0 || "Select at least one platform.",
              })
            : ["paper"];

      const primaryPath = platforms.get(selectedPlatforms[0]).descriptor.path;
      const alien = selectedPlatforms.find((p) => platforms.get(p).descriptor.path !== primaryPath);
      if (alien) {
        throw new InvalidArgumentError(
          `Platform "${alien}" cannot be combined with "${selectedPlatforms[0]}": they target different plugin families ` +
            `("${selectedPlatforms[0]}" writes "${primaryPath}", "${alien}" writes "${platforms.get(alien).descriptor.path}"). ` +
            `Proxy platforms like velocity, waterfall, and travertine each need their own project.`,
        );
      }

      // Workspace-root templates own the per-workspace `main` declarations
      // themselves; the root has no `main`. Detect this by peeking at the
      // template's metadata up front — if it declares a non-empty
      // `projectJsonExtras.workspaces`, we treat it as a workspace root and
      // skip the main prompt / validation. This generalises beyond the
      // builtin templates; any contributed template that scaffolds
      // workspaces gets the same treatment automatically.
      let workspaceRootMetadata: TemplateMetadata | undefined;
      if (options.template !== undefined) {
        try {
          const meta = await getTemplateMetadata(options.template);
          const wsList = (meta.projectJsonExtras as { workspaces?: unknown } | undefined)
            ?.workspaces;
          if (Array.isArray(wsList) && wsList.length > 0) {
            workspaceRootMetadata = meta;
          }
        } catch {
          // Let the later loadTemplate call surface the real error if the
          // id is unknown; here we just fall back to single-project flow.
        }
      }
      const isWorkspaceRootTemplate = workspaceRootMetadata !== undefined;

      // Main class
      const className = deriveClassName(projectName) || "Main";
      const derivedMain = `com.example.${className}`;
      const projectMain = isWorkspaceRootTemplate
        ? undefined
        : (options.main ??
          (interactive
            ? await input({ message: "Main class", default: derivedMain })
            : derivedMain));

      if (
        !isWorkspaceRootTemplate &&
        (!projectMain || !/^[a-zA-Z0-9_.]+$/.test(projectMain) || !projectMain.includes("."))
      ) {
        throw new InvalidArgumentError(
          `Invalid main class: "${projectMain}". It must be a valid Java classpath (e.g. com.example.Main).`,
        );
      }

      // Resolve the Minecraft version for compatibility
      let versions: string[];
      if (options.mcVersion) {
        versions = [options.mcVersion];
      } else {
        log.info(`Fetching latest versions…`);
        const versionLists = await Promise.all(
          selectedPlatforms.map(async (p) => ({
            platform: p,
            versions: await platforms.get(p).versions(),
          })),
        );
        const common =
          versionLists.reduce<string[] | null>((acc, { versions: vs }) => {
            if (acc === null) return vs;
            const set = new Set(vs);
            return acc.filter((v) => set.has(v));
          }, null) ?? [];
        if (common.length === 0) {
          throw new Error(
            `No compatible Minecraft version found across platforms: ${selectedPlatforms.join(", ")}. ` +
              `Try selecting fewer platforms or specifying a version manually with --mc-version.`,
          );
        }
        // Newest common version. The user's local Java is no longer a
        // constraint: pluggy provisions the right JDK on first build.
        versions = [common[0]];
      }

      let INITIAL_PROJECT: Project = {
        name: projectName,
        version: options.version || "1.0.0",
        description: options.description || "A simple Minecraft plugin",
        compatibility: {
          versions,
          platforms: selectedPlatforms,
        },
      };
      if (projectMain !== undefined) {
        INITIAL_PROJECT.main = projectMain;
      }

      const family = platforms.get(selectedPlatforms[0]).descriptor.family;

      // --template: explicit choice. Interactive without --template: prompt
      // with the templates filtered to this project's family. Anything else
      // (--yes, --json, non-TTY): use the embedded stub, no network.
      let templateId: string | undefined = options.template;
      if (templateId === undefined && interactive) {
        try {
          const all = await listTemplates();
          const matches = all.filter((t) => t.family === family);
          if (matches.length > 0) {
            const picked = await select<string>({
              message: "Template",
              default: "__default__",
              choices: [
                {
                  value: "__default__",
                  name: "Default (embedded family stub, no extras)",
                  description: "The minimal scaffold pluggy ships in the binary.",
                },
                ...matches.map((t) => ({
                  value: t.id,
                  name: t.name,
                  description: t.description,
                })),
              ],
            });
            if (picked !== "__default__") templateId = picked;
          }
        } catch (err) {
          log.warn(
            `Could not load template index; falling back to the embedded stub. (${(err as Error).message})`,
          );
        }
      }

      let templateInstance: InstantiatedTemplate | undefined;
      if (templateId !== undefined) {
        // Multi-module templates skip the `main` prompt, but still need a
        // package/class pair to seed the per-workspace stubs they write.
        // Fall back to a derived `com.example.<className>` so substitutions
        // produce sensible defaults.
        const mainForSubstitution = projectMain ?? `com.example.${className}`;
        const tmplClassName = mainForSubstitution.split(".").pop() || "Main";
        const packageName = mainForSubstitution.split(".").slice(0, -1).join(".");
        const apiVersion = deriveApiVersion(versions[0]);
        templateInstance = await loadTemplate(templateId, {
          className: tmplClassName,
          packagePath: packageName.replace(/\./g, "/"),
          replacements: {
            project: {
              ...INITIAL_PROJECT,
              className: tmplClassName,
              packageName,
              velocityId: deriveVelocityId(INITIAL_PROJECT.name),
              spongeId: deriveSpongeId(INITIAL_PROJECT.name),
              ...(apiVersion ? { apiVersion } : {}),
            },
          },
        });

        if (templateInstance.metadata.family !== family) {
          throw new InvalidArgumentError(
            `Template "${templateId}" targets the "${templateInstance.metadata.family}" family ` +
              `but the chosen platform "${selectedPlatforms[0]}" belongs to "${family}". Pick a template ` +
              "that matches your platform, or omit --template for the embedded stub.",
          );
        }

        if (templateInstance.metadata.projectJsonExtras) {
          INITIAL_PROJECT = deepMerge(
            INITIAL_PROJECT as unknown as Record<string, unknown>,
            templateInstance.metadata.projectJsonExtras,
          ) as unknown as Project;
        }
      }

      await generateProject(TARGET_PATH, INITIAL_PROJECT, {
        templateFiles: templateInstance?.files,
      });

      emit(
        {
          status: "success",
          project: INITIAL_PROJECT,
          dir: TARGET_PATH,
          template: templateId,
        },
        () => {
          log.success(`Project ${bold(`"${INITIAL_PROJECT.name}"`)} initialized`);
          if (templateInstance) {
            log.info(`Template: ${bold(templateInstance.metadata.id)}`);
          }

          const isCurrentDir = TARGET_PATH === resolve(process.cwd());
          console.log();
          console.log(dim("  Next steps:"));
          if (!isCurrentDir) console.log(dim(`    cd ${relative(process.cwd(), TARGET_PATH)}`));
          console.log(dim("    pluggy dev"));
        },
      );
    });
}
