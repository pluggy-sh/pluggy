/** Tests for src/build/shade.ts. Uses tiny `yazl`-built jar fixtures. */

import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import yazl from "yazl";

import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";

import type { ResolvedDependency } from "../resolver/index.ts";
import { PENDING_BUILD_INTEGRITY } from "../resolver/workspace.ts";

import { applyShading, matches } from "./shade.ts";

async function makeJar(path: string, entries: Record<string, Buffer | string>): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const zip = new yazl.ZipFile();
    const ws = createWriteStream(path);
    ws.once("error", rejectPromise);
    ws.once("close", () => resolvePromise());
    zip.outputStream.pipe(ws);
    for (const [name, content] of Object.entries(entries)) {
      const buf = typeof content === "string" ? Buffer.from(content, "utf8") : content;
      zip.addBuffer(buf, name);
    }
    zip.end();
  });
}

/**
 * Build a stored (uncompressed) zip from `entries` without any path-safety
 * validation — yazl deliberately rejects `..` and absolute paths, so we
 * can't use it for zip-slip fixtures. Layout: per-entry local headers, then
 * central directory, then EOCD record.
 */
async function makeRawJar(path: string, entries: Record<string, Buffer | string>): Promise<void> {
  const localChunks: Buffer[] = [];
  const centralChunks: Buffer[] = [];
  const offsets: number[] = [];
  let cursor = 0;

  for (const [name, content] of Object.entries(entries)) {
    const data = typeof content === "string" ? Buffer.from(content, "utf8") : content;
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method = stored
    local.writeUInt16LE(0, 10); // mtime
    local.writeUInt16LE(0, 12); // mdate
    local.writeUInt32LE(crc, 14); // crc-32
    local.writeUInt32LE(data.length, 18); // compressed size
    local.writeUInt32LE(data.length, 22); // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    offsets.push(cursor);
    localChunks.push(local, nameBuf, data);
    cursor += local.length + nameBuf.length + data.length;
  }

  const offsetsCopy = [...offsets];
  let cdirSize = 0;
  let i = 0;
  for (const [name, content] of Object.entries(entries)) {
    const data = typeof content === "string" ? Buffer.from(content, "utf8") : content;
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // central dir signature
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(0, 10); // method
    central.writeUInt16LE(0, 12); // mtime
    central.writeUInt16LE(0, 14); // mdate
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra length
    central.writeUInt16LE(0, 32); // comment length
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offsetsCopy[i], 42); // offset of local header
    centralChunks.push(central, nameBuf);
    cdirSize += central.length + nameBuf.length;
    i += 1;
  }

  const cdirOffset = cursor;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // disk
  eocd.writeUInt16LE(0, 6); // disk with cdir start
  eocd.writeUInt16LE(offsets.length, 8); // entries on this disk
  eocd.writeUInt16LE(offsets.length, 10); // total entries
  eocd.writeUInt32LE(cdirSize, 12);
  eocd.writeUInt32LE(cdirOffset, 16);
  eocd.writeUInt16LE(0, 20); // comment length

  await writeFile(path, Buffer.concat([...localChunks, ...centralChunks, eocd]));
}

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function fakeDep(
  name: string,
  jarPath: string,
  integrity = "sha256-aaa",
  kind: "modrinth" | "maven" | "file" | "workspace" = "modrinth",
): ResolvedDependency {
  switch (kind) {
    case "modrinth":
      return {
        source: { kind: "modrinth", slug: name, version: "1.0.0" },
        jarPath,
        integrity,
        transitiveDeps: [],
      };
    case "maven":
      return {
        source: { kind: "maven", groupId: "com.foo", artifactId: name, version: "1.0.0" },
        jarPath,
        integrity,
        transitiveDeps: [],
      };
    case "file":
      return {
        source: { kind: "file", path: `./libs/${name}.jar`, version: "1.0.0" },
        jarPath,
        integrity,
        transitiveDeps: [],
      };
    case "workspace":
      return {
        source: { kind: "workspace", name, version: "1.0.0" },
        jarPath,
        integrity,
        transitiveDeps: [],
      };
  }
}

describe("matches (glob)", () => {
  test("`**` matches any depth", () => {
    expect(matches("com/library/api/Foo.class", ["com/library/api/**"])).toBe(true);
    expect(matches("com/library/api/sub/Bar.class", ["com/library/api/**"])).toBe(true);
    expect(matches("com/library/other/Bar.class", ["com/library/api/**"])).toBe(false);
  });

  test("`*` matches a single path segment", () => {
    expect(matches("com/library/Foo.class", ["com/library/*.class"])).toBe(true);
    expect(matches("com/library/sub/Foo.class", ["com/library/*.class"])).toBe(false);
  });

  test("returns false when no patterns are provided", () => {
    expect(matches("anything", [])).toBe(false);
  });

  test("literal and `**/` combinations", () => {
    expect(matches("META-INF/MANIFEST.MF", ["META-INF/**"])).toBe(true);
    expect(matches("META-INF/MANIFEST.MF", ["**/MANIFEST.MF"])).toBe(true);
    expect(matches("deep/nested/META-INF/MANIFEST.MF", ["**/MANIFEST.MF"])).toBe(true);
  });
});

describe("applyShading", () => {
  let workDir: string;
  let stagingDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "pluggy-shade-work-"));
    stagingDir = await mkdtemp(join(tmpdir(), "pluggy-shade-stage-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
    await rm(stagingDir, { recursive: true, force: true });
  });

  test("dep without a rule is skipped entirely", async () => {
    const jar = join(workDir, "lib.jar");
    await makeJar(jar, {
      "com/library/api/Foo.class": "foo",
      "com/library/internal/Bar.class": "bar",
    });
    const dep = fakeDep("lib", jar);
    await applyShading([dep], {}, stagingDir);

    await expect(readFile(join(stagingDir, "com/library/api/Foo.class"))).rejects.toThrow();
  });

  test("include patterns pull in matching entries", async () => {
    const jar = join(workDir, "lib.jar");
    await makeJar(jar, {
      "com/library/api/Foo.class": "foo",
      "com/library/api/util/Bar.class": "bar",
      "com/library/internal/Hidden.class": "hidden",
    });
    const dep = fakeDep("lib", jar);

    await applyShading([dep], { lib: { include: ["com/library/api/**"] } }, stagingDir);

    const foo = await readFile(join(stagingDir, "com/library/api/Foo.class"), "utf8");
    const bar = await readFile(join(stagingDir, "com/library/api/util/Bar.class"), "utf8");
    expect(foo).toBe("foo");
    expect(bar).toBe("bar");
    await expect(readFile(join(stagingDir, "com/library/internal/Hidden.class"))).rejects.toThrow();
  });

  test("exclude patterns subtract from includes", async () => {
    const jar = join(workDir, "lib.jar");
    await makeJar(jar, {
      "com/library/api/Foo.class": "foo",
      "com/library/api/internal/Bar.class": "bar",
    });
    const dep = fakeDep("lib", jar);

    await applyShading(
      [dep],
      {
        lib: {
          include: ["com/library/api/**"],
          exclude: ["com/library/api/internal/**"],
        },
      },
      stagingDir,
    );

    const foo = await readFile(join(stagingDir, "com/library/api/Foo.class"), "utf8");
    expect(foo).toBe("foo");
    await expect(
      readFile(join(stagingDir, "com/library/api/internal/Bar.class")),
    ).rejects.toThrow();
  });

  test("looks up rules by source-kind-specific name", async () => {
    const jar = join(workDir, "adventure.jar");
    await makeJar(jar, { "net/kyori/adventure/Foo.class": "foo" });

    const mavenDep = fakeDep("adventure-api", jar, "sha256-x", "maven");
    await applyShading([mavenDep], { "adventure-api": { include: ["**"] } }, stagingDir);
    const foo = await readFile(join(stagingDir, "net/kyori/adventure/Foo.class"), "utf8");
    expect(foo).toBe("foo");
  });

  test("workspace sentinel integrity throws if jar is not yet built", async () => {
    const missing = join(workDir, "not-built.jar");
    const dep = fakeDep("suite-api", missing, PENDING_BUILD_INTEGRITY, "workspace");

    await expect(
      applyShading([dep], { "suite-api": { include: ["**"] } }, stagingDir),
    ).rejects.toThrow(/not been built yet/);
  });

  test("throws cleanly when a non-sentinel dep jar is missing", async () => {
    const missing = join(workDir, "gone.jar");
    const dep = fakeDep("gone", missing);
    await expect(applyShading([dep], { gone: { include: ["**"] } }, stagingDir)).rejects.toThrow(
      /jar not found/,
    );
  });

  test("rejects entries that traverse outside stagingDir (zip-slip)", async () => {
    // yauzl's default `validateFileName` rejects `..` filenames before our
    // entry handler sees them, so the surface message comes from there. Our
    // safeJoin call inside `extractEntry` is defense-in-depth for the case
    // someone disables that flag in the future.
    const jar = join(workDir, "evil.jar");
    await makeRawJar(jar, {
      "../../../../../../tmp/pwn.txt": "evil",
    });
    const dep = fakeDep("evil", jar);

    await expect(applyShading([dep], { evil: { include: ["**"] } }, stagingDir)).rejects.toThrow(
      /invalid relative path|refusing entry/,
    );
  });

  test("rejects entries with backslash separators", async () => {
    const jar = join(workDir, "evil-bs.jar");
    await makeRawJar(jar, {
      "..\\..\\windows-pwn.txt": "evil",
    });
    const dep = fakeDep("evil-bs", jar);

    await expect(
      applyShading([dep], { "evil-bs": { include: ["**"] } }, stagingDir),
    ).rejects.toThrow(/invalid relative path|backslash|refusing entry/);
  });
});
