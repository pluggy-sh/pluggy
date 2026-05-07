/** Tests for src/dev/plugins.ts. Uses `yazl`-built jar fixtures in tmpdir. */

import { createWriteStream } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import yazl from "yazl";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";

import type { DescriptorSpec } from "../platform/platform.ts";
import type { ResolvedDependency } from "../resolver/index.ts";

import { isRuntimePlugin, stagePlugins } from "./plugins.ts";

function writeJar(path: string, entries: Record<string, string>): Promise<void> {
  return new Promise<void>((resolvePromise, rejectPromise) => {
    const zip = new yazl.ZipFile();
    for (const [name, content] of Object.entries(entries)) {
      zip.addBuffer(Buffer.from(content), name);
    }
    const ws = createWriteStream(path);
    ws.once("error", rejectPromise);
    ws.once("close", () => resolvePromise());
    zip.outputStream.pipe(ws);
    zip.end();
  });
}

const bukkitDescriptor: DescriptorSpec = {
  path: "plugin.yml",
  format: "yaml",
  family: "bukkit",
  generate: () => "name: fake\n",
};

const velocityDescriptor: DescriptorSpec = {
  path: "velocity-plugin.json",
  format: "json",
  family: "velocity",
  generate: () => "{}",
};

describe("isRuntimePlugin", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "pluggy-dev-plugins-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  test("returns true when jar contains plugin.yml", async () => {
    const jar = join(workDir, "plugin.jar");
    await writeJar(jar, {
      "plugin.yml": "name: foo\nversion: 1.0\n",
      "com/example/Foo.class": "fake-class-bytes",
    });

    const result = await isRuntimePlugin(jar, bukkitDescriptor);
    expect(result).toBe(true);
  });

  test("returns false when jar lacks the descriptor", async () => {
    const jar = join(workDir, "lib.jar");
    await writeJar(jar, {
      "com/example/Lib.class": "bytes",
      "META-INF/MANIFEST.MF": "Manifest-Version: 1.0\n",
    });

    const result = await isRuntimePlugin(jar, bukkitDescriptor);
    expect(result).toBe(false);
  });

  test("uses the descriptor.path to decide — plugin.yml-containing jar is NOT a velocity plugin", async () => {
    const jar = join(workDir, "mixed.jar");
    await writeJar(jar, { "plugin.yml": "name: foo" });

    expect(await isRuntimePlugin(jar, bukkitDescriptor)).toBe(true);
    expect(await isRuntimePlugin(jar, velocityDescriptor)).toBe(false);
  });

  test("rejects on a jar that can't be opened", async () => {
    const jar = join(workDir, "not-a-jar.jar");
    await writeFile(jar, "this is not zip bytes");

    await expect(isRuntimePlugin(jar, bukkitDescriptor)).rejects.toThrow();
  });
});

describe("stagePlugins", () => {
  let workDir: string;
  let devDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "pluggy-dev-stage-plugins-"));
    devDir = join(workDir, "dev");
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  test("places own jar + runtime deps + extras into dev/plugins/", async () => {
    const ownJar = join(workDir, "my-plugin-1.0.0.jar");
    await writeFile(ownJar, "OWN");

    const dep1 = join(workDir, "worldedit-7.jar");
    await writeFile(dep1, "DEP1");
    const dep2 = join(workDir, "placeholderapi.jar");
    await writeFile(dep2, "DEP2");

    const extra = join(workDir, "debug-tools.jar");
    await writeFile(extra, "EXTRA");

    const runtimeDeps: ResolvedDependency[] = [
      {
        source: { kind: "modrinth", slug: "worldedit", version: "7.3.15" },
        jarPath: dep1,
        integrity: "sha256-aaa",
        transitiveDeps: [],
      },
      {
        source: { kind: "modrinth", slug: "placeholderapi", version: "2.11.6" },
        jarPath: dep2,
        integrity: "sha256-bbb",
        transitiveDeps: [],
      },
    ];

    await stagePlugins(devDir, "plugins", ownJar, runtimeDeps, [extra]);

    const names = (await readdir(join(devDir, "plugins"))).sort();
    expect(names).toEqual([
      "debug-tools.jar",
      "my-plugin-1.0.0.jar",
      "placeholderapi.jar",
      "worldedit-7.jar",
    ]);

    expect(await readFile(join(devDir, "plugins", "my-plugin-1.0.0.jar"), "utf8")).toBe("OWN");
    expect(await readFile(join(devDir, "plugins", "worldedit-7.jar"), "utf8")).toBe("DEP1");
    expect(await readFile(join(devDir, "plugins", "debug-tools.jar"), "utf8")).toBe("EXTRA");
  });

  test("creates plugins/ when it doesn't exist", async () => {
    const ownJar = join(workDir, "plugin.jar");
    await writeFile(ownJar, "OWN");

    await stagePlugins(devDir, "plugins", ownJar, [], []);

    const names = await readdir(join(devDir, "plugins"));
    expect(names).toEqual(["plugin.jar"]);
  });

  test("overwrites an existing jar in plugins/", async () => {
    const ownJar = join(workDir, "plugin.jar");
    await writeFile(ownJar, "NEW-OWN");

    await writeFile(join(workDir, "existing-dev"), "");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(devDir, "plugins"), { recursive: true });
    await writeFile(join(devDir, "plugins", "plugin.jar"), "OLD");

    await stagePlugins(devDir, "plugins", ownJar, [], []);
    expect(await readFile(join(devDir, "plugins", "plugin.jar"), "utf8")).toBe("NEW-OWN");
  });

  test("stages into a nested pluginsDir (sponge mods/plugins) and creates parents", async () => {
    const ownJar = join(workDir, "sponge-plugin.jar");
    await writeFile(ownJar, "SPONGE");

    await stagePlugins(devDir, "mods/plugins", ownJar, [], []);

    const names = await readdir(join(devDir, "mods", "plugins"));
    expect(names).toEqual(["sponge-plugin.jar"]);
    expect(await readFile(join(devDir, "mods", "plugins", "sponge-plugin.jar"), "utf8")).toBe(
      "SPONGE",
    );
  });
});
