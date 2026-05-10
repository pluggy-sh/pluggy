/** Tests for src/jar.ts. Fixture JARs are built with yazl in-process. */

import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import yazl from "yazl";

import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";

import { classMajorToJava, readJarClassMajor, readManifestAttribute } from "./jar.ts";

async function makeJar(path: string, entries: Record<string, Buffer | string>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const zip = new yazl.ZipFile();
    const ws = createWriteStream(path);
    ws.once("error", reject);
    ws.once("close", resolve);
    zip.outputStream.pipe(ws);
    for (const [name, content] of Object.entries(entries)) {
      const buf = typeof content === "string" ? Buffer.from(content, "utf8") : content;
      zip.addBuffer(buf, name);
    }
    zip.end();
  });
}

/** Build a minimal class-file buffer with the given major version. */
function classBytes(major: number): Buffer {
  // magic (4) + minor (2) + major (2); rest omitted, jar.ts only reads first 8 bytes
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(0xcafebabe, 0);
  buf.writeUInt16BE(0, 4); // minor
  buf.writeUInt16BE(major, 6);
  return buf;
}

describe("classMajorToJava", () => {
  test("maps well-known major versions to Java releases", () => {
    expect(classMajorToJava(52)).toBe(8);
    expect(classMajorToJava(61)).toBe(17);
    expect(classMajorToJava(65)).toBe(21);
    expect(classMajorToJava(69)).toBe(25);
  });
});

describe("readManifestAttribute", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pluggy-jar-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("returns the attribute value from MANIFEST.MF", async () => {
    const jarPath = join(dir, "test.jar");
    await makeJar(jarPath, {
      "META-INF/MANIFEST.MF": "Manifest-Version: 1.0\nBuild-Jdk-Spec: 21\nCreated-By: Maven\n",
    });
    expect(await readManifestAttribute(jarPath, "Build-Jdk-Spec")).toBe("21");
  });

  test("returns undefined when attribute is absent", async () => {
    const jarPath = join(dir, "test.jar");
    await makeJar(jarPath, {
      "META-INF/MANIFEST.MF": "Manifest-Version: 1.0\n",
    });
    expect(await readManifestAttribute(jarPath, "Build-Jdk-Spec")).toBeUndefined();
  });

  test("returns undefined when MANIFEST.MF is absent", async () => {
    const jarPath = join(dir, "test.jar");
    await makeJar(jarPath, { "com/example/Main.class": classBytes(65) });
    expect(await readManifestAttribute(jarPath, "Build-Jdk-Spec")).toBeUndefined();
  });

  test("returns undefined for a missing file", async () => {
    expect(await readManifestAttribute(join(dir, "missing.jar"), "Build-Jdk-Spec")).toBeUndefined();
  });
});

describe("readJarClassMajor", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pluggy-jar-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("reads major version from first .class file", async () => {
    const jarPath = join(dir, "test.jar");
    await makeJar(jarPath, { "com/example/Main.class": classBytes(65) });
    expect(await readJarClassMajor(jarPath)).toBe(65);
  });

  test("skips module-info.class, reads a regular class", async () => {
    const jarPath = join(dir, "test.jar");
    await makeJar(jarPath, {
      "module-info.class": classBytes(65),
      "com/example/Main.class": classBytes(61),
    });
    expect(await readJarClassMajor(jarPath)).toBe(61);
  });

  test("returns undefined when JAR has no .class files", async () => {
    const jarPath = join(dir, "test.jar");
    await makeJar(jarPath, { "META-INF/MANIFEST.MF": "Manifest-Version: 1.0\n" });
    expect(await readJarClassMajor(jarPath)).toBeUndefined();
  });

  test("returns undefined for a missing file", async () => {
    expect(await readJarClassMajor(join(dir, "missing.jar"))).toBeUndefined();
  });

  test("round-trips through classMajorToJava correctly", async () => {
    const jarPath = join(dir, "test.jar");
    await makeJar(jarPath, { "A.class": classBytes(61) }); // Java 17
    const major = await readJarClassMajor(jarPath);
    expect(classMajorToJava(major!)).toBe(17);
  });
});
