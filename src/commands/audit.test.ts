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

  test("--project <path> resolves the project from outside its directory", async () => {
    await writeProject();
    await writeFile(
      join(rootDir, "pluggy.lock"),
      `${JSON.stringify({ version: 2, entries: {} }, null, 2)}\n`,
    );
    const elsewhere = await mkdtemp(join(tmpdir(), "pluggy-audit-elsewhere-"));
    try {
      const result = await doAudit({ cwd: elsewhere, project: join(rootDir, "project.json") });
      expect(result.ok).toBe(true);
      expect(result.rows).toEqual([]);
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
  });

  describe("human output", () => {
    let stdoutLines: string[];
    let stderrLines: string[];
    const origLog = console.log;
    const origErr = console.error;

    beforeEach(() => {
      stdoutLines = [];
      stderrLines = [];
      console.log = (s: string) => {
        stdoutLines.push(String(s));
      };
      console.error = (s: string) => {
        stderrLines.push(String(s));
      };
      initLogging({ json: false, verbose: false, noColor: true });
    });

    afterEach(() => {
      console.log = origLog;
      console.error = origErr;
    });

    test("failure summary carries the full counts and tampered rows get a heal hint", async () => {
      await writeProject();
      const goodBytes = "good-bytes";
      await writeJar(["modrinth", "good", "1.0.0.jar"], goodBytes);
      await writeJar(["modrinth", "bad", "1.0.0.jar"], "tampered-content");
      await writeFile(
        join(rootDir, "pluggy.lock"),
        `${JSON.stringify(
          {
            version: 2,
            entries: {
              good: {
                source: { kind: "modrinth", slug: "good", version: "1.0.0" },
                resolvedVersion: "1.0.0",
                integrity: sha256(goodBytes),
                declaredBy: ["my-plugin"],
              },
              bad: {
                source: { kind: "modrinth", slug: "bad", version: "1.0.0" },
                resolvedVersion: "1.0.0",
                integrity: sha256("original-content"),
                declaredBy: ["my-plugin"],
              },
              uncached: {
                source: { kind: "modrinth", slug: "uncached", version: "1.0.0" },
                resolvedVersion: "1.0.0",
                integrity: "sha256-abc",
                declaredBy: ["my-plugin"],
              },
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

      await doAudit({ cwd: rootDir });

      const out = stdoutLines.join("\n");
      expect(out).toContain("1 tampered, 1 ok, 1 not cached, 1 skipped (workspace)");
      expect(out).toContain(
        "Run `pluggy install` to re-download; it detects tampering and heals the cache.",
      );
    });

    test("everything missing is not rendered as a clean success", async () => {
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

      expect(result.exitCode).toBe(0);
      const out = stdoutLines.join("\n");
      expect(out).toContain("0 verified; nothing cached yet. Run `pluggy install` first.");
      expect(out).not.toContain("✓");
    });
  });
});
