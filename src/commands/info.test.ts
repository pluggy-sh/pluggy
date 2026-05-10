/** Tests for src/commands/info.ts. `fetch` is stubbed; file tests use tmpdir. */

import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import { initLogging } from "../logging.ts";
import { doInfo } from "./info.ts";

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function errorResponse(status: number, statusText: string): Response {
  return new Response(null, { status, statusText });
}

const origLog = console.log;
beforeEach(() => {
  console.log = () => {};
  initLogging({ json: false, verbose: false, noColor: true });
});
afterEach(() => {
  console.log = origLog;
  vi.unstubAllGlobals();
  initLogging({ json: false, verbose: false, noColor: true });
});

describe("doInfo: modrinth", () => {
  test("fetches project + versions and returns metadata", async () => {
    const project = {
      slug: "worldedit",
      title: "WorldEdit",
      description: "In-game map editor.",
      source_url: "https://github.com/example/worldedit",
      license: { id: "GPL-3.0", name: "GPL-3.0" },
    };
    const versions = [
      {
        id: "v2",
        version_number: "7.3.15",
        version_type: "release",
        date_published: "2025-01-02",
        game_versions: ["1.21.8", "1.21.7"],
      },
      {
        id: "v1",
        version_number: "7.3.14",
        version_type: "release",
        date_published: "2025-01-01",
        game_versions: ["1.21.6"],
      },
    ];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL): Promise<Response> => {
        const s = String(url);
        if (s.endsWith("/project/worldedit")) return okJson(project);
        if (s.endsWith("/project/worldedit/version")) return okJson(versions);
        throw new Error(`unexpected url: ${s}`);
      }),
    );

    const result = await doInfo("worldedit");
    expect(result.kind).toBe("modrinth");
    expect(result.slug).toBe("worldedit");
    expect(result.title).toBe("WorldEdit");
    expect(result.license).toBe("GPL-3.0");
    expect(result.homepage).toBe("https://github.com/example/worldedit");
    expect(Array.isArray(result.versions)).toBe(true);
    const vs = result.versions as Record<string, unknown>[];
    expect(vs).toHaveLength(2);
    expect(vs[0].version).toBe("7.3.15");
    expect(vs[0].type).toBe("release");
  });

  test("throws a helpful error when the slug is unknown", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => errorResponse(404, "Not Found")),
    );
    await expect(doInfo("does-not-exist")).rejects.toThrow(/does-not-exist.*not found/);
  });
});

describe("doInfo: file", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "pluggy-info-file-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  test("returns size and sha-256 for a local jar", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const jarPath = join(tmp, "example.jar");
    await writeFile(jarPath, bytes);

    const result = await doInfo(jarPath);
    expect(result.kind).toBe("file");
    expect(result.path).toBe(jarPath);
    expect(result.size).toBe(5);
    const expected = createHash("sha256").update(bytes).digest("hex");
    expect(result.integrity).toBe(`sha256-${expected}`);
  });

  test("throws when the file does not exist", async () => {
    const missing = join(tmp, "nope.jar");
    await expect(doInfo(missing)).rejects.toThrow(/file not found/);
  });
});

describe("doInfo: workspace", () => {
  let rootDir: string;
  let origCwd: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "pluggy-info-ws-"));
    origCwd = process.cwd();
  });
  afterEach(async () => {
    process.chdir(origCwd);
    await rm(rootDir, { recursive: true, force: true });
  });

  test("shows a sibling workspace's name/version/main from project.json", async () => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(rootDir, "modules", "api"), { recursive: true });
    await writeFile(
      join(rootDir, "project.json"),
      JSON.stringify({
        name: "suite",
        version: "1.0.0",
        compatibility: { versions: ["1.21.8"], platforms: ["paper"] },
        workspaces: ["./modules/api"],
      }),
    );
    await writeFile(
      join(rootDir, "modules", "api", "project.json"),
      JSON.stringify({
        name: "suite-api",
        version: "0.1.0",
        main: "com.example.api.Plugin",
      }),
    );

    process.chdir(rootDir);
    const result = await doInfo("workspace:suite-api");
    expect(result.kind).toBe("workspace");
    expect(result.name).toBe("suite-api");
    expect(result.version).toBe("0.1.0");
    expect(result.main).toBe("com.example.api.Plugin");
  });

  test("throws when the named workspace is not declared", async () => {
    await writeFile(
      join(rootDir, "project.json"),
      JSON.stringify({
        name: "suite",
        version: "1.0.0",
        compatibility: { versions: ["1.21.8"], platforms: ["paper"] },
        workspaces: [],
      }),
    );
    process.chdir(rootDir);
    await expect(doInfo("workspace:ghost")).rejects.toThrow(/workspace not found.*ghost/);
  });
});

describe("doInfo: maven", () => {
  test("documents that a version list is unavailable", async () => {
    const result = await doInfo("maven:net.kyori:adventure-api@4.22.0");
    expect(result.kind).toBe("maven");
    expect(result.coordinate).toBe("net.kyori:adventure-api");
    expect(result.version).toBe("4.22.0");
    expect(result.note).toMatch(/no version list/i);
  });
});
