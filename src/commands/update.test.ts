import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

vi.mock("../resolver/modrinth.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../resolver/modrinth.ts")>()),
  getLatestModrinthVersion: vi.fn(),
}));
vi.mock("../resolver/maven.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../resolver/maven.ts")>()),
  getLatestMavenVersion: vi.fn(),
}));
vi.mock("./install.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./install.ts")>()),
  doInstall: vi.fn(async () => ({ installed: [], skipped: [] })),
}));

import { getLatestMavenVersion } from "../resolver/maven.ts";
import { getLatestModrinthVersion } from "../resolver/modrinth.ts";

import { doInstall } from "./install.ts";
import { doUpdate } from "./update.ts";

let rootDir: string;

async function writeProject(dependencies: Record<string, unknown>): Promise<void> {
  await writeFile(
    join(rootDir, "project.json"),
    `${JSON.stringify(
      {
        name: "my-plugin",
        version: "1.0.0",
        main: "com.example.Main",
        compatibility: { versions: ["1.21.8"], platforms: ["paper"] },
        dependencies,
      },
      null,
      2,
    )}\n`,
  );
}

async function writeLock(entries: Record<string, unknown>): Promise<void> {
  await writeFile(
    join(rootDir, "pluggy.lock"),
    `${JSON.stringify({ version: 2, entries }, null, 2)}\n`,
  );
}

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), "pluggy-update-"));
  vi.mocked(getLatestModrinthVersion).mockReset();
  vi.mocked(getLatestMavenVersion).mockReset();
  vi.mocked(doInstall).mockClear();
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

describe("doUpdate", () => {
  test("plans a bump for every declared dep with a newer upstream", async () => {
    await writeProject({ worldedit: { source: "modrinth:worldedit", version: "7.4.3" } });
    vi.mocked(getLatestModrinthVersion).mockResolvedValue("7.4.4");

    const result = await doUpdate({ cwd: rootDir });

    expect(result.updated).toEqual([
      { name: "worldedit", identifier: "worldedit", from: "7.4.3", to: "7.4.4" },
    ]);
    expect(vi.mocked(doInstall)).toHaveBeenCalledWith(
      expect.objectContaining({ plugin: "worldedit@7.4.4" }),
    );
  });

  test("maven deps are installed by full coordinate, not the lockfile key", async () => {
    await writeProject({
      "adventure-api": { source: "maven:net.kyori:adventure-api", version: "4.17.0" },
    });
    vi.mocked(getLatestMavenVersion).mockResolvedValue("5.2.0");

    const result = await doUpdate({ cwd: rootDir });

    expect(result.updated[0]?.identifier).toBe("maven:net.kyori:adventure-api");
    expect(vi.mocked(doInstall)).toHaveBeenCalledWith(
      expect.objectContaining({ plugin: "maven:net.kyori:adventure-api@5.2.0" }),
    );
  });

  test("--dry-run reports the plan and writes nothing", async () => {
    await writeProject({ worldedit: { source: "modrinth:worldedit", version: "7.4.3" } });
    vi.mocked(getLatestModrinthVersion).mockResolvedValue("7.4.4");

    const result = await doUpdate({ cwd: rootDir, dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.updated).toHaveLength(1);
    expect(vi.mocked(doInstall)).not.toHaveBeenCalled();
  });

  test("already-current deps are reported as unchanged", async () => {
    await writeProject({ worldedit: { source: "modrinth:worldedit", version: "7.4.4" } });
    vi.mocked(getLatestModrinthVersion).mockResolvedValue("7.4.4");

    const result = await doUpdate({ cwd: rootDir });

    expect(result.updated).toEqual([]);
    expect(result.unchanged).toEqual(["worldedit"]);
    expect(vi.mocked(doInstall)).not.toHaveBeenCalled();
  });

  // `install` only writes top-level entries, so a transitive has no direct
  // update path. Saying "not found" would leave the user stuck at the exact
  // point `pluggy outdated` sent them here.
  test("a transitive names the parent to update instead", async () => {
    await writeProject({
      "adventure-api": { source: "maven:net.kyori:adventure-api", version: "4.17.0" },
    });
    await writeLock({
      "adventure-api": {
        source: {
          kind: "maven",
          groupId: "net.kyori",
          artifactId: "adventure-api",
          version: "4.17.0",
        },
        resolvedVersion: "4.17.0",
        integrity: "sha256-x",
        declaredBy: ["my-plugin"],
        transitives: ["net.kyori:adventure-key"],
      },
      "net.kyori:adventure-key": {
        source: {
          kind: "maven",
          groupId: "net.kyori",
          artifactId: "adventure-key",
          version: "4.17.0",
        },
        resolvedVersion: "4.17.0",
        integrity: "sha256-y",
        declaredBy: [],
      },
    });

    await expect(
      doUpdate({ cwd: rootDir, names: ["net.kyori:adventure-key"] }),
    ).rejects.toMatchObject({
      code: "E_UPDATE_TRANSITIVE",
      hint: "Update the dependency that pulls it in: pluggy update adventure-api",
    });
  });

  test("a bare artifact id suggests the full lockfile key", async () => {
    await writeProject({
      "adventure-api": { source: "maven:net.kyori:adventure-api", version: "4.17.0" },
    });
    await writeLock({
      "net.kyori:adventure-key": {
        source: {
          kind: "maven",
          groupId: "net.kyori",
          artifactId: "adventure-key",
          version: "4.17.0",
        },
        resolvedVersion: "4.17.0",
        integrity: "sha256-y",
        declaredBy: [],
      },
    });

    await expect(doUpdate({ cwd: rootDir, names: ["adventure-key"] })).rejects.toMatchObject({
      code: "E_UPDATE_NOT_DECLARED",
      hint: 'Did you mean "net.kyori:adventure-key"?',
    });
  });

  test("workspace and file deps are skipped, not attempted", async () => {
    await writeProject({
      helper: { source: "file:./libs/helper.jar", version: "1.0.0" },
    });

    const result = await doUpdate({ cwd: rootDir });

    expect(result.updated).toEqual([]);
    expect(vi.mocked(doInstall)).not.toHaveBeenCalled();
  });
});
