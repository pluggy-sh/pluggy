/**
 * Per-family runtime layouts. Centralising these keeps the eight platform
 * providers consistent — every bukkit-derived server stages plugins the
 * same way, every proxy skips the vanilla server files, and so on.
 *
 * Override at the provider level if a specific platform needs different
 * values (none do today).
 */

import type { RuntimeLayout } from "./platform.ts";

/** Vanilla MC + bukkit-style descriptor: paper, folia, spigot, bukkit. */
export const BUKKIT_RUNTIME: RuntimeLayout = {
  pluginsDir: "plugins",
  serverArgs: ["nogui"],
  vanillaServerFiles: true,
};

/** Standalone proxy, no MC server: velocity. */
export const VELOCITY_RUNTIME: RuntimeLayout = {
  pluginsDir: "plugins",
  serverArgs: [],
  vanillaServerFiles: false,
};

/** Standalone proxy, no MC server: waterfall, travertine. */
export const BUNGEE_RUNTIME: RuntimeLayout = {
  pluginsDir: "plugins",
  serverArgs: [],
  vanillaServerFiles: false,
};

/**
 * SpongeVanilla wraps the Mojang server jar through ModLauncher: vanilla
 * server files apply, but plugins go in `mods/plugins` (Sponge's launcher
 * default `additional-plugins-directory`) and the launcher expects the
 * `--nogui` long form rather than the bukkit positional `nogui`.
 */
export const SPONGE_RUNTIME: RuntimeLayout = {
  pluginsDir: "mods/plugins",
  serverArgs: ["--nogui"],
  vanillaServerFiles: true,
};
