import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { expect, test } from "vite-plus/test";

import { compile, download, versions } from "../spigot/buildtools.ts";
import type { PlatformContext } from "../platform.ts";

const here = dirname(fileURLToPath(import.meta.url));

// Compile runs java against a live Spigot checkout: needs Java 8-21, takes
// minutes. Gated behind PLUGGY_INTEGRATION=1.
const integration = process.env.PLUGGY_INTEGRATION === "1";

test("BuildTools download", async () => {
  const ctx: PlatformContext = {
    getCachePath: () => join(here, ".buildtools"),
  };

  await mkdir(ctx.getCachePath(), { recursive: true });

  const path = await download(ctx);
  expect(typeof path).toBe("string");
  expect(existsSync(path)).toBe(true);
  expect(statSync(path).isFile()).toBe(true);
  expect(readFileSync(path).byteLength).toBeGreaterThan(0);

  await rm(ctx.getCachePath(), { recursive: true, force: true });
});

test("BuildTools versions", async () => {
  const versionsList = await versions();
  expect(Array.isArray(versionsList)).toBe(true);
  expect(versionsList.length).toBeGreaterThan(0);
  expect(versionsList[0].length).toBeGreaterThan(0);
});

test.runIf(integration)("BuildTools compile", async () => {
  const ctx: PlatformContext = {
    getCachePath: () => join(here, ".buildtools"),
  };

  const latestVersion = (await versions())[0];

  await mkdir(ctx.getCachePath(), { recursive: true });

  {
    const compiler = await compile(ctx, "1.16.4", "craftbukkit");
    expect(compiler.type).toBe("craftbukkit");
    expect(compiler.version).toBe("1.16.4");
    await expect(compiler.output()).rejects.toThrow(
      /requires Java versions between \[Java 8, Java 15\]/,
    );
  }

  {
    const compiler = await compile(ctx, latestVersion, "spigot");
    expect(compiler.type).toBe("spigot");
    expect(compiler.version).toBe(latestVersion);
    const output = await compiler.output();
    expect(output.byteLength).toBeGreaterThan(0);
  }

  await rm(ctx.getCachePath(), { recursive: true, force: true });
});
