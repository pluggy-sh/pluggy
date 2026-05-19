/**
 * Platform registry. Providers self-register via `createPlatform` at
 * module-load time; callers read the registry through the `platforms`
 * category object: `platforms.get(id)`, `platforms.list()`,
 * `platforms.assertSameFamily(ids)`.
 *
 * The registry is module-scoped because the Bun-compiled binary boots
 * from a read-only `$bunfs` and providers must register their static
 * shape before the command layer reads it. `createPlatform` is the only
 * write path; it must not perform I/O at load time.
 */

import type { ResolvedProject } from "../project.ts";

import { UserError } from "../errors.ts";
import { getCachePath } from "../project.ts";

/** Concrete version identifier: upstream version string + its build number. */
export interface Version {
  version: string;
  build: number;
}

/** Maven coordinates a platform exposes for downstream compilation. */
export interface MavenAPI {
  repositories: string[];
  dependencies: Array<{ groupId: string; artifactId: string; version: string }>;
}

/**
 * Family of plugin platforms that share a runtime API: bukkit-derivatives
 * (paper/folia/spigot/bukkit), velocity proxies, bungee proxies, or sponge
 * (SpongeVanilla + SpongeAPI). Used by the scaffolder + template selector to
 * pick a stub class that actually compiles against the chosen platform.
 */
export type PlatformFamily = "bukkit" | "velocity" | "bungee" | "sponge";

/** How a plugin descriptor is serialized into the final jar. */
export interface DescriptorSpec {
  /** Path inside the final plugin jar where the descriptor is written. */
  path: string;
  format: "yaml" | "json" | "toml";
  /** Family this descriptor belongs to. Drives stub-class selection. */
  family: PlatformFamily;
  generate(project: ResolvedProject): string;
}

/**
 * Per-platform runtime layout. Tells `pluggy dev` how to stage the working
 * directory and how to invoke the server jar. Without it, dev would have
 * to special-case every family.
 */
export interface RuntimeLayout {
  /**
   * Path under `dev/` where plugin jars are dropped. Forward-slashed,
   * relative to the dev directory. Bukkit-family servers use `"plugins"`,
   * SpongeVanilla 8+ uses `"mods/plugins"` (its launcher's default
   * `additional-plugins-directory`), proxies use `"plugins"`.
   */
  pluginsDir: string;
  /**
   * Arguments appended after `-jar server.jar`. The Mojang vanilla server
   * jar accepts the positional `nogui`; SpongeVanilla goes through
   * ModLauncher and expects `--nogui`; Velocity and Bungee accept neither.
   */
  serverArgs: string[];
  /**
   * Whether the server reads `eula.txt` and `server.properties` from its
   * working directory. Vanilla MC wrappers (paper/folia/spigot/bukkit/sponge)
   * do; standalone proxies (velocity/bungee) ignore both.
   */
  vanillaServerFiles: boolean;
}

/** Contract each platform (paper, spigot, ...) implements. */
export interface PlatformProvider {
  id: string;
  descriptor: DescriptorSpec;
  /** Layout + invocation hints used by `pluggy dev`. */
  runtime: RuntimeLayout;

  versions(): Promise<string[]>;
  latest(): Promise<Version>;
  info(version: string): Promise<Version>;

  /** Fetch (or retrieve from cache) the platform server jar. */
  download(version: Version, ignoreCache: boolean): Promise<Version & { output: Uint8Array }>;

  api(version: string): Promise<MavenAPI>;
}

/** Everything a provider factory is allowed to read from the runtime. */
export interface PlatformContext {
  getCachePath(): string;
}

const PLATFORMS: Record<string, PlatformProvider> = {};

/**
 * Human-friendly aliases that resolve to a registered platform id.
 * BungeeCord proxies are served by the Waterfall provider (Waterfall is the
 * actively-maintained PaperMC fork of BungeeCord), so users typing the
 * upstream name land on the right provider.
 */
const ALIASES: Record<string, string> = {
  bungee: "waterfall",
  bungeecord: "waterfall",
};

/**
 * Define and register a platform provider. The factory runs at module-load
 * time and must not perform I/O. The Bun-compiled binary ships a read-only
 * `$bunfs` and would crash on disk writes before command dispatch.
 */
export function createPlatform<T extends PlatformProvider>(
  provider: (context: PlatformContext) => T,
): T {
  const platform = provider({ getCachePath });
  PLATFORMS[platform.id.toLowerCase()] = platform;
  return platform;
}

/**
 * Read API over the platform registry. Lookups, listing, and validation
 * are exposed as single-word actions on this category. The category
 * supplies context, so the actions stay concise.
 */
export const platforms = {
  /** Look up a registered platform by id or alias (case-insensitive). Throws if missing. */
  get(this: void, providerId: string): PlatformProvider {
    const id = platforms.resolve(providerId);
    if (id === undefined) {
      const known = Object.keys(PLATFORMS).sort();
      throw new UserError(`Platform with id '${providerId}' not found`, {
        code: "E_PLATFORM_UNKNOWN",
        hint:
          known.length > 0 ? `Known: ${known.join(", ")}` : "No platforms have been registered.",
        context: { providerId, known },
      });
    }
    return PLATFORMS[id];
  },

  /**
   * Resolve an id-or-alias to a canonical platform id. Returns `undefined`
   * when neither matches. Callers that want a hard failure should use
   * `platforms.get()`.
   */
  resolve(this: void, providerId: string): string | undefined {
    const key = providerId.toLowerCase();
    if (PLATFORMS[key]) return key;
    const aliased = ALIASES[key];
    if (aliased !== undefined && PLATFORMS[aliased]) return aliased;
    return undefined;
  },

  /** List every registered platform id, lowercased. */
  list(this: void): string[] {
    return Object.keys(PLATFORMS);
  },

  /** Aliases that resolve to canonical ids. Keys are user-facing inputs. */
  aliases(this: void): Record<string, string> {
    return { ...ALIASES };
  },

  /**
   * Validate that every id in `ids` resolves to a registered platform and
   * that they all share one `descriptor.family`. Returns that family.
   *
   * A plugin can only target one family at a time. Bukkit-derived APIs and
   * proxy APIs (velocity, bungee) don't share an entry-point class, so
   * mixing them in `compatibility.platforms` is always a project-config bug.
   */
  assertSameFamily(this: void, ids: string[]): PlatformFamily {
    if (ids.length === 0) {
      throw new UserError("compatibility.platforms is empty. At least one platform is required.", {
        code: "E_PLATFORM_NO_PLATFORMS",
        hint: 'Add at least one platform to "compatibility.platforms" in project.json.',
      });
    }

    const byFamily = new Map<PlatformFamily, string[]>();
    for (const id of ids) {
      const family = platforms.get(id).descriptor.family;
      const list = byFamily.get(family) ?? [];
      list.push(id);
      byFamily.set(family, list);
    }

    if (byFamily.size > 1) {
      const groups = Array.from(byFamily.entries())
        .map(([family, group]) => `${family} (${group.join(", ")})`)
        .join(" vs ");
      const groupsContext = Array.from(byFamily.entries()).map(([family, group]) => ({
        family,
        platforms: group,
      }));
      throw new UserError(
        `compatibility.platforms must share one family. Got ${groups}. ` +
          "Split platforms from different families into separate workspaces.",
        {
          code: "E_PLATFORM_FAMILIES_MIXED",
          hint: "Split platforms from different families into separate workspaces.",
          context: { groups: groupsContext },
        },
      );
    }

    return byFamily.keys().next().value as PlatformFamily;
  },
} as const;
