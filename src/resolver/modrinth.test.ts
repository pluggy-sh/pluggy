/**
 * Contract tests for src/resolver/modrinth.ts. Network I/O is mocked via
 * `vi.stubGlobal("fetch", ...)` so the suite runs offline.
 */

import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import { getCachePath } from "../project.ts";

import type { ResolveContext } from "./index.ts";
import { resolveModrinth } from "./modrinth.ts";

interface ModrinthVersion {
  id: string;
  version_number: string;
  version_type: "release" | "beta" | "alpha";
  files: {
    url: string;
    filename: string;
    primary: boolean;
    hashes: { sha1?: string; sha512?: string };
  }[];
}

function mkVersion(
  version_number: string,
  version_type: ModrinthVersion["version_type"],
  url: string,
  hashes: { sha1?: string; sha512?: string } = {},
): ModrinthVersion {
  return {
    id: `id-${version_number}`,
    version_number,
    version_type,
    files: [{ url, filename: `${version_number}.jar`, primary: true, hashes }],
  };
}

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function okBinary(bytes: Uint8Array): Response {
  return new Response(bytes, {
    status: 200,
    headers: { "content-type": "application/java-archive" },
  });
}

function errorResponse(status: number, statusText: string): Response {
  return new Response(null, { status, statusText });
}

const ctx: ResolveContext = {
  rootDir: "/tmp",
  includePrerelease: false,
  force: false,
  registries: [],
};

describe("resolveModrinth", () => {
  // Redirect the user cache into a tempdir so tests don't pollute the host.
  let cacheRoot: string;
  let origHome: string | undefined;
  let origXdg: string | undefined;
  let origLocalAppData: string | undefined;

  beforeEach(async () => {
    cacheRoot = await mkdtemp(join(tmpdir(), "pluggy-modrinth-"));
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
    vi.unstubAllGlobals();
    await rm(cacheRoot, { recursive: true, force: true });
  });

  test("resolves latest stable release when version === '*'", async () => {
    const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const versions: ModrinthVersion[] = [
      mkVersion("2.0.0-beta.1", "beta", "https://cdn/beta.jar"),
      mkVersion("1.5.0", "release", "https://cdn/1.5.0.jar"),
      mkVersion("1.4.0", "release", "https://cdn/1.4.0.jar"),
    ];

    const fetchMock = vi.fn(async (url: string | URL): Promise<Response> => {
      const s = String(url);
      if (s.includes("/project/")) return okJson(versions);
      if (s === "https://cdn/1.5.0.jar") return okBinary(bytes);
      throw new Error(`unexpected url: ${s}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const got = await resolveModrinth("worldedit", "*", ctx);

    expect(got.source).toEqual({ kind: "modrinth", slug: "worldedit", version: "1.5.0" });
    expect(got.jarPath).toBe(
      join(getCachePath(), "dependencies", "modrinth", "worldedit", "1.5.0.jar"),
    );
    expect(got.transitiveDeps).toEqual([]);
    const expectedHex = createHash("sha256").update(bytes).digest("hex");
    expect(got.integrity).toBe(`sha256-${expectedHex}`);
    const written = await readFile(got.jarPath);
    expect(new Uint8Array(written)).toEqual(bytes);
  });

  test("resolves the newest version (including pre-release) when includePrerelease=true", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const versions: ModrinthVersion[] = [
      mkVersion("2.0.0-beta.1", "beta", "https://cdn/beta.jar"),
      mkVersion("1.5.0", "release", "https://cdn/1.5.0.jar"),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL): Promise<Response> => {
        const s = String(url);
        if (s.includes("/project/")) return okJson(versions);
        if (s === "https://cdn/beta.jar") return okBinary(bytes);
        throw new Error(`unexpected url: ${s}`);
      }),
    );

    const got = await resolveModrinth("worldedit", "*", { ...ctx, includePrerelease: true });
    expect(got.source.version).toBe("2.0.0-beta.1");
  });

  test("pins to an exact version_number when version is concrete", async () => {
    const bytes = new Uint8Array([9, 9, 9]);
    const versions: ModrinthVersion[] = [
      mkVersion("2.0.0", "release", "https://cdn/2.0.0.jar"),
      mkVersion("1.5.0", "release", "https://cdn/1.5.0.jar"),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL): Promise<Response> => {
        const s = String(url);
        if (s.includes("/project/")) return okJson(versions);
        if (s === "https://cdn/1.5.0.jar") return okBinary(bytes);
        throw new Error(`unexpected url: ${s}`);
      }),
    );

    const got = await resolveModrinth("worldedit", "1.5.0", ctx);
    expect(got.source).toEqual({ kind: "modrinth", slug: "worldedit", version: "1.5.0" });
  });

  test("throws a helpful error listing available versions when the pin doesn't match", async () => {
    const versions: ModrinthVersion[] = [
      mkVersion("2.0.0", "release", "https://cdn/2.0.0.jar"),
      mkVersion("1.5.0", "release", "https://cdn/1.5.0.jar"),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => okJson(versions)),
    );

    await expect(resolveModrinth("worldedit", "9.9.9", ctx)).rejects.toThrow(
      /9\.9\.9.*worldedit.*available: 2\.0\.0, 1\.5\.0/s,
    );
  });

  test("refuses a concrete pre-release pin without --beta", async () => {
    const versions: ModrinthVersion[] = [mkVersion("3.0.0-beta", "beta", "https://cdn/beta.jar")];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => okJson(versions)),
    );

    await expect(resolveModrinth("worldedit", "3.0.0-beta", ctx)).rejects.toThrow(
      /pre-release|--beta/,
    );
  });

  test("throws when no stable release is available and --beta is off", async () => {
    const versions: ModrinthVersion[] = [mkVersion("3.0.0-beta", "beta", "https://cdn/beta.jar")];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => okJson(versions)),
    );

    await expect(resolveModrinth("betaonly", "*", ctx)).rejects.toThrow(/stable.*--beta/s);
  });

  test("throws when the Modrinth API returns a non-200", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => errorResponse(404, "Not Found")),
    );
    await expect(resolveModrinth("nope", "*", ctx)).rejects.toThrow(/Modrinth API.*"nope".*404/s);
  });

  test("rejects downloads whose bytes don't match Modrinth's published sha512", async () => {
    const bytes = new Uint8Array([0xaa, 0xbb, 0xcc]);
    const wrongSha512 = "f".repeat(128);
    const versions: ModrinthVersion[] = [
      mkVersion("1.0.0", "release", "https://cdn/1.0.0.jar", { sha512: wrongSha512 }),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL): Promise<Response> => {
        const s = String(url);
        if (s.includes("/project/")) return okJson(versions);
        if (s === "https://cdn/1.0.0.jar") return okBinary(bytes);
        throw new Error(`unexpected url: ${s}`);
      }),
    );

    await expect(resolveModrinth("evil", "1.0.0", ctx)).rejects.toThrow(/sha512 mismatch/);
  });

  test("rejects when expectedIntegrity from the lockfile doesn't match resolved bytes", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const realSha512 = createHash("sha512").update(bytes).digest("hex");
    const versions: ModrinthVersion[] = [
      mkVersion("1.0.0", "release", "https://cdn/1.0.0.jar", { sha512: realSha512 }),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL): Promise<Response> => {
        const s = String(url);
        if (s.includes("/project/")) return okJson(versions);
        if (s === "https://cdn/1.0.0.jar") return okBinary(bytes);
        throw new Error(`unexpected url: ${s}`);
      }),
    );

    await expect(
      resolveModrinth("worldedit", "1.0.0", { ...ctx, expectedIntegrity: "sha256-pinned" }),
    ).rejects.toThrow(/integrity check failed/);
  });

  test("skips the download when the cached jar already exists", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const versions: ModrinthVersion[] = [mkVersion("1.0.0", "release", "https://cdn/1.0.0.jar")];

    const firstFetch = vi.fn(async (url: string | URL): Promise<Response> => {
      const s = String(url);
      if (s.includes("/project/")) return okJson(versions);
      if (s === "https://cdn/1.0.0.jar") return okBinary(bytes);
      throw new Error(`unexpected url: ${s}`);
    });
    vi.stubGlobal("fetch", firstFetch);
    await resolveModrinth("slugA", "*", ctx);
    expect(firstFetch).toHaveBeenCalledTimes(2);

    // Second pass should only hit the version API, never the jar URL.
    const secondFetch = vi.fn(async (url: string | URL): Promise<Response> => {
      const s = String(url);
      if (s.includes("/project/")) return okJson(versions);
      throw new Error(`should not have fetched ${s}; cache should be hit`);
    });
    vi.stubGlobal("fetch", secondFetch);
    const second = await resolveModrinth("slugA", "*", ctx);
    expect(secondFetch).toHaveBeenCalledTimes(1);
    const expectedHex = createHash("sha256").update(bytes).digest("hex");
    expect(second.integrity).toBe(`sha256-${expectedHex}`);
  });
});
