/** Contract tests for the pluggy.lock reader/writer. */

import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";

import { type Lockfile, pulledInBy, readLock, verifyLock, writeLock } from "./lockfile.ts";

describe("lockfile I/O", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "pluggy-lockfile-"));
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  test("readLock returns null when no lockfile exists", () => {
    expect(readLock(rootDir)).toBeNull();
  });

  test("writeLock then readLock round-trips", async () => {
    const lock: Lockfile = {
      version: 2,
      entries: {
        worldedit: {
          source: { kind: "modrinth", slug: "worldedit", version: "7.3.15" },
          resolvedVersion: "7.3.15",
          integrity: "sha256-abc",
          declaredBy: ["my-plugin"],
        },
      },
    };
    await writeLock(rootDir, lock);
    const read = readLock(rootDir);
    expect(read).toEqual(lock);
  });

  test("lockfile is valid JSON on disk", async () => {
    const lock: Lockfile = { version: 2, entries: {} };
    await writeLock(rootDir, lock);
    const raw = await readFile(join(rootDir, "pluggy.lock"), "utf8");
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  test("writeLock emits 2-space-indented JSON with trailing LF", async () => {
    const lock: Lockfile = {
      version: 2,
      entries: {
        worldedit: {
          source: { kind: "modrinth", slug: "worldedit", version: "7.3.15" },
          resolvedVersion: "7.3.15",
          integrity: "sha256-abc",
          declaredBy: ["my-plugin"],
        },
      },
    };
    await writeLock(rootDir, lock);
    const raw = await readFile(join(rootDir, "pluggy.lock"), "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    const lines = raw.split("\n");
    expect(lines[1].startsWith('  "')).toBe(true);
    expect(raw.includes("\t")).toBe(false);
  });

  test("writeLock sorts entries alphabetically regardless of input order", async () => {
    const lock: Lockfile = {
      version: 2,
      entries: {
        zzz: {
          source: { kind: "modrinth", slug: "zzz", version: "1.0.0" },
          resolvedVersion: "1.0.0",
          integrity: "sha256-z",
          declaredBy: ["root"],
        },
        mmm: {
          source: { kind: "modrinth", slug: "mmm", version: "1.0.0" },
          resolvedVersion: "1.0.0",
          integrity: "sha256-m",
          declaredBy: ["root"],
        },
        aaa: {
          source: { kind: "modrinth", slug: "aaa", version: "1.0.0" },
          resolvedVersion: "1.0.0",
          integrity: "sha256-a",
          declaredBy: ["root"],
        },
      },
    };
    await writeLock(rootDir, lock);
    const raw = await readFile(join(rootDir, "pluggy.lock"), "utf8");
    const aIdx = raw.indexOf('"aaa"');
    const mIdx = raw.indexOf('"mmm"');
    const zIdx = raw.indexOf('"zzz"');
    expect(aIdx).toBeGreaterThan(-1);
    expect(mIdx).toBeGreaterThan(aIdx);
    expect(zIdx).toBeGreaterThan(mIdx);
  });

  test("writeLock leaves no temp files behind on the happy path", async () => {
    const lock: Lockfile = { version: 2, entries: {} };
    await writeLock(rootDir, lock);
    const files = await readdir(rootDir);
    expect(files).toEqual(["pluggy.lock"]);
  });

  test("readLock throws a descriptive error on corrupt JSON", async () => {
    await writeFile(join(rootDir, "pluggy.lock"), "{ not json", "utf8");
    expect(() => readLock(rootDir)).toThrow(/Failed to parse lockfile/);
    expect(() => readLock(rootDir)).toThrow(new RegExp(rootDir.replace(/\\/g, "\\\\")));
  });

  test("readLock throws on an unsupported version field", async () => {
    await writeFile(
      join(rootDir, "pluggy.lock"),
      JSON.stringify({ version: 1, entries: {} }),
      "utf8",
    );
    expect(() => readLock(rootDir)).toThrow(/Unsupported lockfile version: 1/);
  });

  test("readLock throws when entries is not an object", async () => {
    await writeFile(
      join(rootDir, "pluggy.lock"),
      JSON.stringify({ version: 2, entries: [] }),
      "utf8",
    );
    expect(() => readLock(rootDir)).toThrow(/"entries" must be an object/);
  });

  test("readLock names the offending entry when integrity is missing", async () => {
    await writeFile(
      join(rootDir, "pluggy.lock"),
      JSON.stringify({
        version: 2,
        entries: {
          worldedit: {
            source: { kind: "modrinth", slug: "worldedit", version: "7.3.15" },
            resolvedVersion: "7.3.15",
            declaredBy: ["my-plugin"],
          },
        },
      }),
      "utf8",
    );
    expect(() => readLock(rootDir)).toThrow(/worldedit/);
    expect(() => readLock(rootDir)).toThrow(/integrity/);
  });

  test("writeLock then readLock round-trips a flat transitives graph", async () => {
    const lock: Lockfile = {
      version: 2,
      entries: {
        "paper-api": {
          source: {
            kind: "maven",
            groupId: "io.papermc.paper",
            artifactId: "paper-api",
            version: "1.21.8-R0.1-SNAPSHOT",
          },
          resolvedVersion: "1.21.8-R0.1-SNAPSHOT",
          integrity: "sha256-paper",
          declaredBy: ["my-plugin"],
          transitives: ["net.kyori:adventure-api", "com.google.guava:guava"],
        },
        "net.kyori:adventure-api": {
          source: {
            kind: "maven",
            groupId: "net.kyori",
            artifactId: "adventure-api",
            version: "4.14.0",
          },
          resolvedVersion: "4.14.0",
          integrity: "sha256-adv",
          declaredBy: [],
          transitives: ["net.kyori:examination-api"],
        },
        "net.kyori:examination-api": {
          source: {
            kind: "maven",
            groupId: "net.kyori",
            artifactId: "examination-api",
            version: "1.3.0",
          },
          resolvedVersion: "1.3.0",
          integrity: "sha256-exam",
          declaredBy: [],
        },
        "com.google.guava:guava": {
          source: {
            kind: "maven",
            groupId: "com.google.guava",
            artifactId: "guava",
            version: "32.1.2",
          },
          resolvedVersion: "32.1.2",
          integrity: "sha256-guava",
          declaredBy: [],
        },
      },
    };
    await writeLock(rootDir, lock);
    const read = readLock(rootDir);
    expect(read).toEqual(lock);
  });

  test("readLock rejects a non-array transitives field", async () => {
    await writeFile(
      join(rootDir, "pluggy.lock"),
      JSON.stringify({
        version: 2,
        entries: {
          foo: {
            source: { kind: "modrinth", slug: "foo", version: "1.0.0" },
            resolvedVersion: "1.0.0",
            integrity: "sha256-a",
            declaredBy: ["root"],
            transitives: "nope",
          },
        },
      }),
      "utf8",
    );
    expect(() => readLock(rootDir)).toThrow(/"transitives" must be an array/);
  });

  test("readLock rejects a transitives array with non-string entries", async () => {
    await writeFile(
      join(rootDir, "pluggy.lock"),
      JSON.stringify({
        version: 2,
        entries: {
          foo: {
            source: { kind: "modrinth", slug: "foo", version: "1.0.0" },
            resolvedVersion: "1.0.0",
            integrity: "sha256-a",
            declaredBy: ["root"],
            transitives: [{ name: "bar" }],
          },
        },
      }),
      "utf8",
    );
    expect(() => readLock(rootDir)).toThrow(/"transitives" must be an array of strings/);
  });

  test("readLock rejects an unknown source kind", async () => {
    await writeFile(
      join(rootDir, "pluggy.lock"),
      JSON.stringify({
        version: 2,
        entries: {
          bogus: {
            source: { kind: "github", repo: "foo/bar", version: "1.0.0" },
            resolvedVersion: "1.0.0",
            integrity: "sha256-x",
            declaredBy: ["root"],
          },
        },
      }),
      "utf8",
    );
    expect(() => readLock(rootDir)).toThrow(/unknown source kind "github"/);
  });
});

describe("verifyLock", () => {
  test("reports declared deps that are missing from the lock", () => {
    const lock: Lockfile = { version: 2, entries: {} };
    const missing = verifyLock(lock, {
      worldedit: { source: { kind: "modrinth", slug: "worldedit", version: "7.3.15" } },
    });
    expect(missing).toContain("worldedit");
  });

  test("returns empty when every declared dep is locked", () => {
    const lock: Lockfile = {
      version: 2,
      entries: {
        worldedit: {
          source: { kind: "modrinth", slug: "worldedit", version: "7.3.15" },
          resolvedVersion: "7.3.15",
          integrity: "sha256-abc",
          declaredBy: ["my-plugin"],
        },
      },
    };
    const missing = verifyLock(lock, {
      worldedit: { source: { kind: "modrinth", slug: "worldedit", version: "7.3.15" } },
    });
    expect(missing).toEqual([]);
  });

  test("reports stale entries when the source kind has drifted", () => {
    const lock: Lockfile = {
      version: 2,
      entries: {
        foo: {
          source: {
            kind: "maven",
            groupId: "com.example",
            artifactId: "foo",
            version: "1.0.0",
          },
          resolvedVersion: "1.0.0",
          integrity: "sha256-xyz",
          declaredBy: ["root"],
        },
      },
    };
    const drift = verifyLock(lock, {
      foo: { source: { kind: "modrinth", slug: "foo", version: "1.0.0" } },
    });
    expect(drift).toEqual(["foo"]);
  });

  test("reports stale entries when only the version has drifted", () => {
    const lock: Lockfile = {
      version: 2,
      entries: {
        worldedit: {
          source: { kind: "modrinth", slug: "worldedit", version: "7.3.15" },
          resolvedVersion: "7.3.15",
          integrity: "sha256-abc",
          declaredBy: ["my-plugin"],
        },
      },
    };
    const drift = verifyLock(lock, {
      worldedit: { source: { kind: "modrinth", slug: "worldedit", version: "7.3.0" } },
    });
    expect(drift).toEqual(["worldedit"]);
  });

  test("ignores extra lockfile entries that aren't declared (orphans are not stale)", () => {
    const lock: Lockfile = {
      version: 2,
      entries: {
        worldedit: {
          source: { kind: "modrinth", slug: "worldedit", version: "7.3.15" },
          resolvedVersion: "7.3.15",
          integrity: "sha256-abc",
          declaredBy: ["my-plugin"],
        },
        orphan: {
          source: { kind: "modrinth", slug: "orphan", version: "1.0.0" },
          resolvedVersion: "1.0.0",
          integrity: "sha256-orph",
          declaredBy: ["some-removed-workspace"],
        },
      },
    };
    const drift = verifyLock(lock, {
      worldedit: { source: { kind: "modrinth", slug: "worldedit", version: "7.3.15" } },
    });
    expect(drift).toEqual([]);
  });
});

describe("pulledInBy", () => {
  test("maps every entry to its parent set", () => {
    const lock: Lockfile = {
      version: 2,
      entries: {
        a: {
          source: { kind: "modrinth", slug: "a", version: "1.0.0" },
          resolvedVersion: "1.0.0",
          integrity: "sha256-a",
          declaredBy: ["root"],
          transitives: ["b", "c"],
        },
        b: {
          source: { kind: "modrinth", slug: "b", version: "1.0.0" },
          resolvedVersion: "1.0.0",
          integrity: "sha256-b",
          declaredBy: [],
          transitives: ["c"],
        },
        c: {
          source: { kind: "modrinth", slug: "c", version: "1.0.0" },
          resolvedVersion: "1.0.0",
          integrity: "sha256-c",
          declaredBy: [],
        },
      },
    };
    const reverse = pulledInBy(lock);
    expect(reverse.a).toEqual([]);
    expect(reverse.b.sort()).toEqual(["a"]);
    expect(reverse.c.sort()).toEqual(["a", "b"]);
  });

  test("returns empty arrays for entries that nothing pulls in", () => {
    const lock: Lockfile = {
      version: 2,
      entries: {
        only: {
          source: { kind: "modrinth", slug: "only", version: "1.0.0" },
          resolvedVersion: "1.0.0",
          integrity: "sha256-x",
          declaredBy: ["root"],
        },
      },
    };
    const reverse = pulledInBy(lock);
    expect(reverse.only).toEqual([]);
  });
});
