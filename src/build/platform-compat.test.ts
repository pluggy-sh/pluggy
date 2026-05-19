/**
 * Multi-platform compile-compatibility tests.
 *
 * These tests call real javac and download real platform API JARs (paper-api,
 * spigot-api). JARs are cached in the pluggy cache after the first run, so
 * subsequent runs are fast. A JDK with `javac` on PATH is required.
 *
 * Three fixtures cover the interesting cases:
 *
 *   basic-plugin      : only Bukkit API         → paper ✔  spigot ✔
 *   paper-plugin      : uses Paper-specific API  → paper ✔  spigot ✖
 *   reflection-plugin : reaches Paper via        → paper ✔  spigot ✔
 *                       Class.forName (no import)
 *
 * Skipped on Windows: vitest's forks pool crashes the worker during teardown
 * after the long-running javac spawns finish, causing intermittent CI
 * failures. The tests themselves exercise OS-agnostic javac+classpath logic
 * already covered on the ubuntu and macos legs, so the Windows skip costs
 * coverage nothing while removing ~70s of flaky runtime.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { platform } from "node:process";

import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";

import { checkPlatformCompile } from "./index.ts";
import type { ResolvedProject } from "../project.ts";

// ---------------------------------------------------------------------------
// Java source fixtures
// ---------------------------------------------------------------------------

const BASIC_PLUGIN_JAVA = `
package com.example;

import org.bukkit.plugin.java.JavaPlugin;

public class BasicPlugin extends JavaPlugin {
    @Override public void onEnable()  { getLogger().info("enabled");  }
    @Override public void onDisable() { getLogger().info("disabled"); }
}
`.trimStart();

// AsyncChatEvent exists in paper-api but not in spigot-api.
const PAPER_PLUGIN_JAVA = `
package com.example;

import io.papermc.paper.event.player.AsyncChatEvent;
import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;
import org.bukkit.plugin.java.JavaPlugin;

public class PaperPlugin extends JavaPlugin implements Listener {
    @Override
    public void onEnable() {
        getServer().getPluginManager().registerEvents(this, this);
    }

    @EventHandler
    public void onChat(AsyncChatEvent event) {
        // Paper-specific event, not available in spigot-api
    }
}
`.trimStart();

// Uses Class.forName instead of an import: compiles on any API.
const REFLECTION_PLUGIN_JAVA = `
package com.example;

import org.bukkit.plugin.java.JavaPlugin;

public class ReflectionPlugin extends JavaPlugin {
    @Override
    public void onEnable() {
        try {
            Class<?> cls = Class.forName("io.papermc.paper.event.player.AsyncChatEvent");
            getLogger().info("Paper detected: " + cls.getSimpleName());
        } catch (ClassNotFoundException e) {
            getLogger().info("Not running on Paper, using fallback");
        }
    }
}
`.trimStart();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeFixture(
  rootDir: string,
  javaSource: string,
  className: string,
  platforms: string[],
): Promise<ResolvedProject> {
  const srcPkg = join(rootDir, "src", "com", "example");
  await mkdir(srcPkg, { recursive: true });
  await writeFile(join(srcPkg, `${className}.java`), javaSource);
  const project: ResolvedProject = {
    name: className.toLowerCase(),
    version: "1.0.0",
    main: `com.example.${className}`,
    compatibility: { versions: ["1.21.4"], platforms },
    rootDir,
    projectFile: join(rootDir, "project.json"),
  };
  await writeFile(join(rootDir, "project.json"), JSON.stringify(project, null, 2));
  return project;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(platform === "win32")(
  "checkPlatformCompile: basic plugin (Bukkit-only API)",
  { timeout: 120_000 },
  () => {
    let dir: string;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "pluggy-compat-basic-"));
    });
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    test("compiles against paper", async () => {
      const project = await makeFixture(dir, BASIC_PLUGIN_JAVA, "BasicPlugin", ["paper"]);
      await expect(checkPlatformCompile(project, "paper")).resolves.toBeUndefined();
    });

    test("compiles against spigot", async () => {
      const project = await makeFixture(dir, BASIC_PLUGIN_JAVA, "BasicPlugin", ["spigot"]);
      await expect(checkPlatformCompile(project, "spigot")).resolves.toBeUndefined();
    });
  },
);

describe.skipIf(platform === "win32")(
  "checkPlatformCompile: paper plugin (Paper-specific API)",
  { timeout: 120_000 },
  () => {
    let dir: string;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "pluggy-compat-paper-"));
    });
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    test("compiles against paper", async () => {
      const project = await makeFixture(dir, PAPER_PLUGIN_JAVA, "PaperPlugin", ["paper"]);
      await expect(checkPlatformCompile(project, "paper")).resolves.toBeUndefined();
    });

    test("fails to compile against spigot (AsyncChatEvent not in spigot-api)", async () => {
      const project = await makeFixture(dir, PAPER_PLUGIN_JAVA, "PaperPlugin", ["spigot"]);
      await expect(checkPlatformCompile(project, "spigot")).rejects.toThrow();
    });
  },
);

describe.skipIf(platform === "win32")(
  "checkPlatformCompile: reflection plugin (runtime-agnostic)",
  { timeout: 120_000 },
  () => {
    let dir: string;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "pluggy-compat-reflect-"));
    });
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    test("compiles against paper", async () => {
      const project = await makeFixture(dir, REFLECTION_PLUGIN_JAVA, "ReflectionPlugin", ["paper"]);
      await expect(checkPlatformCompile(project, "paper")).resolves.toBeUndefined();
    });

    test("compiles against spigot (no hard import; reflection only)", async () => {
      const project = await makeFixture(dir, REFLECTION_PLUGIN_JAVA, "ReflectionPlugin", [
        "spigot",
      ]);
      await expect(checkPlatformCompile(project, "spigot")).resolves.toBeUndefined();
    });
  },
);
