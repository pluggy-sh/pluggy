/** Tests for src/docs/javadoc.ts. `spawn` is stubbed; no real javadoc. */

import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
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

import { runJavadoc } from "./javadoc.ts";

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
  child: EventEmitter & { stdout: Readable; stderr: Readable };
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
      setImmediate(() => ee.emit("close", code));
    },
    emitStderr(text) {
      stderr.push(text);
    },
  };
}

describe("runJavadoc", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "pluggy-docs-"));
    vi.mocked(spawn).mockReset();
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  test("spawns javadoc with -d, encoding flags, sourcepath, classpath, and sources", async () => {
    vi.mocked(spawn).mockImplementation(() => {
      const h = fakeChild();
      h.emitExit(0);
      return h.child as unknown as ReturnType<typeof spawn>;
    });

    const outDir = join(workDir, "site");
    const srcDir = join(workDir, "src");

    await runJavadoc(makeProject(workDir), {
      sources: [join(srcDir, "Foo.java"), join(srcDir, "Bar.java")],
      outputDir: outDir,
      sourcePaths: [srcDir],
      classpath: ["/some/dep.jar", "/other/dep.jar"],
      access: "protected",
      release: 21,
      quiet: true,
      windowTitle: "testplugin 1.0.0",
      docTitle: "testplugin 1.0.0",
      links: [],
    });

    expect(spawn).toHaveBeenCalledTimes(1);
    const [cmd, args] = vi.mocked(spawn).mock.calls[0];
    expect(cmd).toBe("javadoc");

    const argv = args as string[];
    expect(argv[argv.indexOf("-d") + 1]).toBe(outDir);
    expect(argv[argv.indexOf("-encoding") + 1]).toBe("UTF-8");
    expect(argv[argv.indexOf("-docencoding") + 1]).toBe("UTF-8");
    expect(argv[argv.indexOf("-charset") + 1]).toBe("UTF-8");
    expect(argv).toContain("-protected");
    expect(argv[argv.indexOf("--release") + 1]).toBe("21");
    expect(argv).toContain("-quiet");
    expect(argv[argv.indexOf("-sourcepath") + 1]).toBe(srcDir);
    expect(argv[argv.indexOf("-classpath") + 1]).toBe(
      ["/some/dep.jar", "/other/dep.jar"].join(delimiter),
    );
    expect(argv).toContain(join(srcDir, "Foo.java"));
    expect(argv).toContain(join(srcDir, "Bar.java"));
  });

  test("emits one -link <url> per cross-link entry", async () => {
    vi.mocked(spawn).mockImplementation(() => {
      const h = fakeChild();
      h.emitExit(0);
      return h.child as unknown as ReturnType<typeof spawn>;
    });

    await runJavadoc(makeProject(workDir), {
      sources: [join(workDir, "A.java")],
      outputDir: join(workDir, "site"),
      sourcePaths: [workDir],
      classpath: [],
      access: "public",
      release: 21,
      quiet: true,
      windowTitle: "x",
      docTitle: "x",
      links: ["https://docs.oracle.com/en/java/javase/21/docs/api/", "https://example.invalid/jd/"],
    });

    const argv = vi.mocked(spawn).mock.calls[0][1] as string[];
    const linkIndices: number[] = [];
    argv.forEach((a, i) => {
      if (a === "-link") linkIndices.push(i);
    });
    expect(linkIndices).toHaveLength(2);
    expect(argv[linkIndices[0] + 1]).toBe("https://docs.oracle.com/en/java/javase/21/docs/api/");
    expect(argv[linkIndices[1] + 1]).toBe("https://example.invalid/jd/");
  });

  test("non-zero exit throws with last 40 stderr lines", async () => {
    vi.mocked(spawn).mockImplementation(() => {
      const h = fakeChild();
      const lines: string[] = [];
      for (let i = 1; i <= 60; i++) lines.push(`javadoc-error-line-${i}`);
      h.emitStderr(`${lines.join("\n")}\n`);
      h.emitExit(1);
      return h.child as unknown as ReturnType<typeof spawn>;
    });

    await expect(
      runJavadoc(makeProject(workDir), {
        sources: [join(workDir, "A.java")],
        outputDir: join(workDir, "site"),
        sourcePaths: [workDir],
        classpath: [],
        access: "protected",
        release: 21,
        quiet: true,
        windowTitle: "x",
        docTitle: "x",
        links: [],
      }),
    ).rejects.toThrow(/javadoc exited with code 1/);
  });

  test("counts diagnostic-style warning lines from stderr", async () => {
    vi.mocked(spawn).mockImplementation(() => {
      const h = fakeChild();
      h.emitStderr(
        [
          "/src/Foo.java:10: warning: [removal] foo() is deprecated",
          "/src/Bar.java:3: warning: [unchecked] unchecked cast",
          "Generating index.html",
          "",
        ].join("\n"),
      );
      h.emitExit(0);
      return h.child as unknown as ReturnType<typeof spawn>;
    });

    const result = await runJavadoc(makeProject(workDir), {
      sources: [join(workDir, "A.java")],
      outputDir: join(workDir, "site"),
      sourcePaths: [workDir],
      classpath: [],
      access: "protected",
      release: 21,
      quiet: false,
      windowTitle: "x",
      docTitle: "x",
      links: [],
    });

    expect(result.warnings).toBe(2);
  });

  test("rejects when sources is empty", async () => {
    await expect(
      runJavadoc(makeProject(workDir), {
        sources: [],
        outputDir: join(workDir, "site"),
        sourcePaths: [workDir],
        classpath: [],
        access: "protected",
        release: 21,
        quiet: true,
        windowTitle: "x",
        docTitle: "x",
        links: [],
      }),
    ).rejects.toThrow(/no \.java sources/);
    expect(spawn).not.toHaveBeenCalled();
  });
});
