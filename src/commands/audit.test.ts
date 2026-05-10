import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";

import { initLogging } from "../logging.ts";

import { doAudit } from "./audit.ts";

describe("doAudit", () => {
  let rootDir: string;
  let homeDir: string;
  let savedHome: string | undefined;
  let savedXdg: string | undefined;
  let savedAppData: string | undefined;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "pluggy-audit-"));
    homeDir = await mkdtemp(join(tmpdir(), "pluggy-audit-home-"));
    // Override every platform's cache-root anchor so getCachePath() points at
    // homeDir regardless of OS.
    savedHome = process.env.HOME;
    savedXdg = process.env.XDG_CACHE_HOME;
    savedAppData = process.env.LOCALAPPDATA;
    process.env.HOME = homeDir;
    process.env.XDG_CACHE_HOME = join(homeDir, ".cache");
    process.env.LOCALAPPDATA = join(homeDir, "AppData", "Local");
    initLogging({ json: true });
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
    restoreEnv("HOME", savedHome);
    restoreEnv("XDG_CACHE_HOME", savedXdg);
    restoreEnv("LOCALAPPDATA", savedAppData);
    initLogging({ json: false });
  });

  function restoreEnv(name: string, original: string | undefined): void {
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  }

  function cacheRoot(): string {
    if (process.platform === "darwin") return join(homeDir, "Library", "Caches", "pluggy");
    if (process.platform === "win32") return join(homeDir, "AppData", "Local", "pluggy", "cache");
    return join(homeDir, ".cache", "pluggy");
  }

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

  function sha256(bytes: Buffer | string): string {
    return `sha256-${createHash("sha256").update(bytes).digest("hex")}`;
  }

  async function writeJar(rel: string[], contents: string): Promise<string> {
    const path = join(cacheRoot(), "dependencies", ...rel);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, contents);
    return path;
  }

  test("ok when every jar matches its lockfile integrity", async () => {
    await writeProject();
    const fooBytes = "foo-bytes";
    const barBytes = "bar-bytes";
    await writeJar(["modrinth", "foo", "1.0.0.jar"], fooBytes);
    await writeJar(["maven", "com.example", "bar", "1.0.0.jar"], barBytes);

    await writeFile(
      join(rootDir, "pluggy.lock"),
      `${JSON.stringify(
        {
          version: 2,
          entries: {
            foo: {
              source: { kind: "modrinth", slug: "foo", version: "1.0.0" },
              resolvedVersion: "1.0.0",
              integrity: sha256(fooBytes),
              declaredBy: ["my-plugin"],
            },
            bar: {
              source: {
                kind: "maven",
                groupId: "com.example",
                artifactId: "bar",
                version: "1.0.0",
              },
              resolvedVersion: "1.0.0",
              integrity: sha256(barBytes),
              declaredBy: ["my-plugin"],
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    const result = await doAudit({ cwd: rootDir });

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.summary.ok).toBe(2);
    expect(result.summary.tampered).toBe(0);
    expect(result.rows.every((r) => r.status === "ok")).toBe(true);
  });

  test("flags tampered bytes with status='tampered' and exit 1", async () => {
    await writeProject();
    await writeJar(["modrinth", "foo", "1.0.0.jar"], "tampered-content");
    await writeFile(
      join(rootDir, "pluggy.lock"),
      `${JSON.stringify(
        {
          version: 2,
          entries: {
            foo: {
              source: { kind: "modrinth", slug: "foo", version: "1.0.0" },
              resolvedVersion: "1.0.0",
              integrity: sha256("original-content"),
              declaredBy: ["my-plugin"],
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    const result = await doAudit({ cwd: rootDir });

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.summary.tampered).toBe(1);
    const row = result.rows.find((r) => r.name === "foo");
    expect(row?.status).toBe("tampered");
    expect(row?.expected).toBe(sha256("original-content"));
    expect(row?.actual).toBe(sha256("tampered-content"));
  });

  test("missing cache jar is reported as 'missing', not a failure", async () => {
    await writeProject();
    await writeFile(
      join(rootDir, "pluggy.lock"),
      `${JSON.stringify(
        {
          version: 2,
          entries: {
            foo: {
              source: { kind: "modrinth", slug: "foo", version: "1.0.0" },
              resolvedVersion: "1.0.0",
              integrity: "sha256-abc",
              declaredBy: ["my-plugin"],
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    const result = await doAudit({ cwd: rootDir });

    expect(result.ok).toBe(true);
    expect(result.summary.missing).toBe(1);
    expect(result.rows.find((r) => r.name === "foo")?.status).toBe("missing");
  });

  test("workspace deps are skipped (not cached)", async () => {
    await writeProject();
    await writeFile(
      join(rootDir, "pluggy.lock"),
      `${JSON.stringify(
        {
          version: 2,
          entries: {
            sibling: {
              source: { kind: "workspace", name: "sibling", version: "*" },
              resolvedVersion: "1.0.0",
              integrity: "sha256-x",
              declaredBy: ["my-plugin"],
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    const result = await doAudit({ cwd: rootDir });

    expect(result.summary.skipped).toBe(1);
    expect(result.rows[0].status).toBe("skipped");
  });

  test("throws E_AUDIT_NO_LOCKFILE when pluggy.lock is missing", async () => {
    await writeProject();
    await expect(doAudit({ cwd: rootDir })).rejects.toThrow(/no pluggy\.lock/i);
  });
});
