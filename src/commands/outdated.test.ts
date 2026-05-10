import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

vi.mock("../resolver/modrinth.ts", () => ({
  getLatestModrinthVersion: vi.fn(),
}));
vi.mock("../resolver/maven.ts", () => ({
  getLatestMavenVersion: vi.fn(),
}));

import { getLatestMavenVersion } from "../resolver/maven.ts";
import { getLatestModrinthVersion } from "../resolver/modrinth.ts";

import { initLogging } from "../logging.ts";
import { doOutdated } from "./outdated.ts";

describe("doOutdated", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "pluggy-outdated-"));
    initLogging({ json: true });
    vi.mocked(getLatestModrinthVersion).mockReset();
    vi.mocked(getLatestMavenVersion).mockReset();
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
    initLogging({ json: false });
  });

  async function writeProject(): Promise<void> {
    await writeFile(
      join(rootDir, "project.json"),
      JSON.stringify({
        name: "my-plugin",
        version: "1.0.0",
        compatibility: { versions: ["1.21.8"], platforms: ["paper"] },
      }),
    );
  }

  async function writeLockfile(entries: Record<string, unknown>): Promise<void> {
    await writeFile(
      join(rootDir, "pluggy.lock"),
      `${JSON.stringify({ version: 2, entries }, null, 2)}\n`,
    );
  }

  test("classifies major / minor / patch / same correctly", async () => {
    await writeProject();
    await writeLockfile({
      "stale-major": {
        source: { kind: "modrinth", slug: "stale-major", version: "1.2.3" },
        resolvedVersion: "1.2.3",
        integrity: "sha256-x",
        declaredBy: ["my-plugin"],
      },
      "stale-minor": {
        source: { kind: "modrinth", slug: "stale-minor", version: "1.2.3" },
        resolvedVersion: "1.2.3",
        integrity: "sha256-x",
        declaredBy: ["my-plugin"],
      },
      "stale-patch": {
        source: { kind: "modrinth", slug: "stale-patch", version: "1.2.3" },
        resolvedVersion: "1.2.3",
        integrity: "sha256-x",
        declaredBy: ["my-plugin"],
      },
      fresh: {
        source: { kind: "modrinth", slug: "fresh", version: "1.2.3" },
        resolvedVersion: "1.2.3",
        integrity: "sha256-x",
        declaredBy: ["my-plugin"],
      },
    });

    vi.mocked(getLatestModrinthVersion).mockImplementation(async (slug) => {
      if (slug === "stale-major") return "2.0.0";
      if (slug === "stale-minor") return "1.3.0";
      if (slug === "stale-patch") return "1.2.4";
      if (slug === "fresh") return "1.2.3";
      return undefined;
    });

    const result = await doOutdated({ cwd: rootDir });

    const byName = Object.fromEntries(result.rows.map((r) => [r.name, r]));
    expect(byName["stale-major"].diff).toBe("major");
    expect(byName["stale-minor"].diff).toBe("minor");
    expect(byName["stale-patch"].diff).toBe("patch");
    expect(byName["fresh"].diff).toBe("same");
    expect(result.outdatedCount).toBe(3);
  });

  test("file and workspace sources are diff='unknown'", async () => {
    await writeProject();
    await writeLockfile({
      "local-jar": {
        source: { kind: "file", path: "./libs/foo.jar", version: "*" },
        resolvedVersion: "1.0.0",
        integrity: "sha256-x",
        declaredBy: ["my-plugin"],
      },
      "sibling-mod": {
        source: { kind: "workspace", name: "sibling-mod", version: "*" },
        resolvedVersion: "0.1.0",
        integrity: "sha256-y",
        declaredBy: ["my-plugin"],
      },
    });

    const result = await doOutdated({ cwd: rootDir });

    expect(result.rows.find((r) => r.name === "local-jar")?.diff).toBe("unknown");
    expect(result.rows.find((r) => r.name === "sibling-mod")?.diff).toBe("unknown");
    expect(getLatestModrinthVersion).not.toHaveBeenCalled();
    expect(getLatestMavenVersion).not.toHaveBeenCalled();
  });

  test("network failure on one entry doesn't kill the report", async () => {
    await writeProject();
    await writeLockfile({
      bad: {
        source: { kind: "modrinth", slug: "bad", version: "1.0.0" },
        resolvedVersion: "1.0.0",
        integrity: "sha256-x",
        declaredBy: ["my-plugin"],
      },
      good: {
        source: { kind: "modrinth", slug: "good", version: "1.0.0" },
        resolvedVersion: "1.0.0",
        integrity: "sha256-x",
        declaredBy: ["my-plugin"],
      },
    });

    vi.mocked(getLatestModrinthVersion).mockImplementation(async (slug) => {
      if (slug === "bad") throw new Error("registry 503");
      if (slug === "good") return "1.0.0";
      return undefined;
    });

    const result = await doOutdated({ cwd: rootDir });

    const bad = result.rows.find((r) => r.name === "bad");
    const good = result.rows.find((r) => r.name === "good");
    expect(bad?.diff).toBe("error");
    expect(bad?.error).toMatch(/503/);
    expect(good?.diff).toBe("same");
  });

  test("only top-level entries count toward outdatedCount", async () => {
    await writeProject();
    await writeLockfile({
      "top-stale": {
        source: { kind: "modrinth", slug: "top-stale", version: "1.0.0" },
        resolvedVersion: "1.0.0",
        integrity: "sha256-x",
        declaredBy: ["my-plugin"],
      },
      "transitive-stale": {
        source: { kind: "modrinth", slug: "transitive-stale", version: "1.0.0" },
        resolvedVersion: "1.0.0",
        integrity: "sha256-y",
        declaredBy: [],
      },
    });

    vi.mocked(getLatestModrinthVersion).mockResolvedValue("2.0.0");

    const result = await doOutdated({ cwd: rootDir });
    expect(result.outdatedCount).toBe(1);
  });

  test("throws E_OUTDATED_NO_LOCKFILE when no pluggy.lock", async () => {
    await writeProject();
    await expect(doOutdated({ cwd: rootDir })).rejects.toThrow(/no pluggy\.lock/i);
  });
});
