/** Contract tests for src/resolver/file.ts. */

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import { getCachePath } from "../project.ts";

import type { ResolveContext } from "./index.ts";
import { resolveFile } from "./file.ts";

describe("resolveFile", () => {
  let workDir: string;
  let cacheRoot: string;
  let origHome: string | undefined;
  let origXdg: string | undefined;
  let origLocalAppData: string | undefined;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "pluggy-file-work-"));
    cacheRoot = await mkdtemp(join(tmpdir(), "pluggy-file-cache-"));
    origHome = process.env.HOME;
    origXdg = process.env.XDG_CACHE_HOME;
    origLocalAppData = process.env.LOCALAPPDATA;
    process.env.HOME = cacheRoot;
    process.env.XDG_CACHE_HOME = cacheRoot;
    process.env.LOCALAPPDATA = cacheRoot;
  });

  afterEach(async () => {
    process.env.HOME = origHome;
    process.env.XDG_CACHE_HOME = origXdg;
    process.env.LOCALAPPDATA = origLocalAppData;
    vi.restoreAllMocks();
    await rm(workDir, { recursive: true, force: true });
    await rm(cacheRoot, { recursive: true, force: true });
  });

  test("resolves an existing jar and places it in the content-addressed cache", async () => {
    const libs = join(workDir, "libs");
    await mkdir(libs, { recursive: true });
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xff, 0xee]);
    const src = join(libs, "foo.jar");
    await writeFile(src, bytes);

    const ctx: ResolveContext = {
      rootDir: workDir,
      includePrerelease: false,
      force: false,
      registries: [],
    };

    const got = await resolveFile("./libs/foo.jar", "1.0.0", ctx);

    const expectedHex = createHash("sha256").update(bytes).digest("hex");
    expect(got.integrity).toBe(`sha256-${expectedHex}`);
    expect(got.source).toEqual({ kind: "file", path: "./libs/foo.jar", version: "1.0.0" });
    expect(got.jarPath).toBe(join(getCachePath(), "dependencies", "file", `${expectedHex}.jar`));
    expect(got.transitiveDeps).toEqual([]);

    const cached = await readFile(got.jarPath);
    expect(new Uint8Array(cached)).toEqual(bytes);
  });

  test("accepts absolute paths", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const src = join(workDir, "abs.jar");
    await writeFile(src, bytes);

    const ctx: ResolveContext = {
      rootDir: "/not/used/when/absolute",
      includePrerelease: false,
      force: false,
      registries: [],
    };

    const got = await resolveFile(src, "*", ctx);
    const expectedHex = createHash("sha256").update(bytes).digest("hex");
    expect(got.integrity).toBe(`sha256-${expectedHex}`);
  });

  test("throws a clear error when the file does not exist", async () => {
    const ctx: ResolveContext = {
      rootDir: workDir,
      includePrerelease: false,
      force: false,
      registries: [],
    };

    await expect(resolveFile("./libs/missing.jar", "1.0.0", ctx)).rejects.toThrow(
      /file source not found.*missing\.jar/s,
    );
  });

  test("rejects the resolve when expectedIntegrity disagrees with the file bytes", async () => {
    const bytes = new Uint8Array([42, 42, 42]);
    await writeFile(join(workDir, "ours.jar"), bytes);

    const ctx: ResolveContext = {
      rootDir: workDir,
      includePrerelease: false,
      force: false,
      registries: [],
      expectedIntegrity: "sha256-pinned",
    };

    await expect(resolveFile("./ours.jar", "1", ctx)).rejects.toThrow(/integrity check failed/);
  });

  test("byte-identical files from different source paths hash to the same cache entry", async () => {
    const bytes = new Uint8Array([7, 7, 7]);
    await writeFile(join(workDir, "a.jar"), bytes);
    await writeFile(join(workDir, "b.jar"), bytes);

    const ctx: ResolveContext = {
      rootDir: workDir,
      includePrerelease: false,
      force: false,
      registries: [],
    };

    const first = await resolveFile("./a.jar", "1", ctx);
    const second = await resolveFile("./b.jar", "1", ctx);
    expect(first.jarPath).toBe(second.jarPath);
    expect(first.integrity).toBe(second.integrity);
  });
});
