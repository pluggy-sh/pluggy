/** Tests for src/build/compile.ts. `spawn` is stubbed; no real javac. */

import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { Readable } from "node:stream";

import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import type { ResolvedProject } from "../project.ts";

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, spawn: vi.fn() };
});

import { spawn } from "node:child_process";

import { compileJava } from "./compile.ts";

function makeProject(rootDir: string): ResolvedProject {
  return {
    name: "testplugin",
    version: "1.0.0",
    main: "com.example.Main",
    compatibility: { versions: ["1.21.8"], platforms: ["paper"] },
    rootDir,
    projectFile: join(rootDir, "project.json"),
  };
}

interface FakeChildHandle {
  child: EventEmitter & {
    stdout: Readable;
    stderr: Readable;
  };
  emitExit: (code: number) => void;
  emitStderr: (text: string) => void;
}

function fakeChild(): FakeChildHandle {
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  const ee = new EventEmitter() as EventEmitter & { stdout: Readable; stderr: Readable };
  ee.stdout = stdout;
  ee.stderr = stderr;
  return {
    child: ee,
    emitExit(code) {
      // Yield so queued data chunks flush before the close event.
      setImmediate(() => ee.emit("close", code));
    },
    emitStderr(text) {
      stderr.push(text);
    },
  };
}

describe("compileJava", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "pluggy-compile-"));
    vi.mocked(spawn).mockReset();
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  test("spawns javac with -d, -encoding, -cp, and the discovered sources", async () => {
    const srcDir = join(workDir, "src");
    const outDir = join(workDir, "out");
    await mkdir(join(srcDir, "com", "example"), { recursive: true });
    await writeFile(join(srcDir, "com", "example", "Main.java"), "class Main {}");
    await writeFile(join(srcDir, "com", "example", "Other.java"), "class Other {}");
    await writeFile(join(srcDir, "notes.txt"), "ignore me");

    vi.mocked(spawn).mockImplementation(() => {
      const h = fakeChild();
      h.emitExit(0);
      return h.child as unknown as ReturnType<typeof spawn>;
    });

    const project = makeProject(workDir);
    await compileJava(project, {
      sourceDir: srcDir,
      outputDir: outDir,
      classpath: ["/some/dep.jar", "/other/dep.jar"],
    });

    expect(spawn).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = vi.mocked(spawn).mock.calls[0];
    expect(cmd).toBe("javac");
    expect(opts).toMatchObject({ stdio: ["ignore", "pipe", "pipe"] });

    const argList = args as string[];
    expect(argList).toContain("-encoding");
    expect(argList[argList.indexOf("-encoding") + 1]).toBe("UTF-8");
    expect(argList).toContain("-d");
    expect(argList[argList.indexOf("-d") + 1]).toBe(outDir);
    expect(argList).toContain("-cp");
    expect(argList[argList.indexOf("-cp") + 1]).toBe(
      ["/some/dep.jar", "/other/dep.jar"].join(delimiter),
    );
    expect(argList).toContain(join(srcDir, "com", "example", "Main.java"));
    expect(argList).toContain(join(srcDir, "com", "example", "Other.java"));
    expect(argList.some((a: string) => a.endsWith("notes.txt"))).toBe(false);
  });

  test("omits -cp when classpath is empty", async () => {
    const srcDir = join(workDir, "src");
    await mkdir(srcDir, { recursive: true });
    await writeFile(join(srcDir, "A.java"), "class A {}");

    vi.mocked(spawn).mockImplementation(() => {
      const h = fakeChild();
      h.emitExit(0);
      return h.child as unknown as ReturnType<typeof spawn>;
    });

    const project = makeProject(workDir);
    await compileJava(project, {
      sourceDir: srcDir,
      outputDir: join(workDir, "out"),
      classpath: [],
    });

    const argList = vi.mocked(spawn).mock.calls[0][1] as string[];
    expect(argList).not.toContain("-cp");
  });

  test("non-zero exit throws with last 40 stderr lines", async () => {
    const srcDir = join(workDir, "src");
    await mkdir(srcDir, { recursive: true });
    await writeFile(join(srcDir, "Bad.java"), "class Bad");

    vi.mocked(spawn).mockImplementation(() => {
      const h = fakeChild();
      const lines: string[] = [];
      for (let i = 1; i <= 60; i++) lines.push(`javac-error-line-${i}`);
      h.emitStderr(`${lines.join("\n")}\n`);
      h.emitExit(1);
      return h.child as unknown as ReturnType<typeof spawn>;
    });

    const project = makeProject(workDir);
    const promise = compileJava(project, {
      sourceDir: srcDir,
      outputDir: join(workDir, "out"),
      classpath: [],
    });

    await expect(promise).rejects.toThrow(/javac exited with code 1/);
  });

  test("stderr excerpt preserves only the last 40 lines on failure", async () => {
    const srcDir = join(workDir, "src");
    await mkdir(srcDir, { recursive: true });
    await writeFile(join(srcDir, "Bad.java"), "class Bad");

    vi.mocked(spawn).mockImplementation(() => {
      const h = fakeChild();
      const lines: string[] = [];
      for (let i = 1; i <= 60; i++) lines.push(`javac-error-line-${i}`);
      h.emitStderr(`${lines.join("\n")}\n`);
      h.emitExit(1);
      return h.child as unknown as ReturnType<typeof spawn>;
    });

    const project = makeProject(workDir);
    let message = "";
    try {
      await compileJava(project, {
        sourceDir: srcDir,
        outputDir: join(workDir, "out"),
        classpath: [],
      });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("javac-error-line-60");
    expect(message).not.toContain("javac-error-line-1\n");
    expect(message).not.toMatch(/javac-error-line-1$/);
  });

  test("errors when no .java sources are found", async () => {
    const srcDir = join(workDir, "src");
    await mkdir(srcDir, { recursive: true });

    const project = makeProject(workDir);
    await expect(
      compileJava(project, {
        sourceDir: srcDir,
        outputDir: join(workDir, "out"),
        classpath: [],
      }),
    ).rejects.toThrow(/no \.java sources found/);
  });

  test("surfaces spawn errors as a clear message", async () => {
    const srcDir = join(workDir, "src");
    await mkdir(srcDir, { recursive: true });
    await writeFile(join(srcDir, "A.java"), "class A {}");

    vi.mocked(spawn).mockImplementation(() => {
      const h = fakeChild();
      setImmediate(() => h.child.emit("error", new Error("ENOENT: javac not found")));
      return h.child as unknown as ReturnType<typeof spawn>;
    });

    const project = makeProject(workDir);
    await expect(
      compileJava(project, {
        sourceDir: srcDir,
        outputDir: join(workDir, "out"),
        classpath: [],
      }),
    ).rejects.toThrow(/failed to spawn javac.*ENOENT/);
  });
});
