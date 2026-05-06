/**
 * Tests for src/docs/index.ts. Mocks classpath resolution, JDK lookup, and
 * `spawn`; exercises the orchestrator's wiring rather than real javadoc.
 */

import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import type { ResolvedProject } from "../project.ts";

vi.mock("../build/classpath.ts", () => ({
  resolveProjectClasspath: vi.fn(async () => ({
    deps: [],
    platformApiJars: ["/fake/paper-api.jar"],
    classpath: ["/fake/paper-api.jar"],
  })),
}));
vi.mock("../sdk/index.ts", () => ({
  ensureJdkForProject: vi.fn(async () => ({
    javaPath: "java",
    javacPath: "javac",
    javaHome: "/fake",
    major: 21,
    source: "system" as const,
    distribution: "system",
    selection: { major: 21, distribution: "temurin", source: "fallback-default" as const },
  })),
}));
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, spawn: vi.fn() };
});

import { spawn } from "node:child_process";

import { generateDocs } from "./index.ts";

function makeProject(rootDir: string, overrides: Partial<ResolvedProject> = {}): ResolvedProject {
  return {
    name: "testplugin",
    version: "1.0.0",
    main: "com.example.Main",
    compatibility: { versions: ["1.21.8"], platforms: ["paper"] },
    rootDir,
    projectFile: join(rootDir, "project.json"),
    ...overrides,
  };
}

function fakeChild(): {
  child: EventEmitter & { stdout: Readable; stderr: Readable };
  close: (code: number) => void;
} {
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  const ee = new EventEmitter() as EventEmitter & { stdout: Readable; stderr: Readable };
  ee.stdout = stdout;
  ee.stderr = stderr;
  return { child: ee, close: (code) => setImmediate(() => ee.emit("close", code)) };
}

describe("generateDocs", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "pluggy-docs-orch-"));
    vi.mocked(spawn).mockReset();
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  test("invokes javadoc with the resolved classpath, JDK release, and source files", async () => {
    await mkdir(join(workDir, "src", "com", "example"), { recursive: true });
    await writeFile(
      join(workDir, "src", "com", "example", "Main.java"),
      "package com.example; class Main {}",
    );

    vi.mocked(spawn).mockImplementation((_cmd: unknown, _args: unknown) => {
      const args = _args as string[];
      const handle = fakeChild();
      const dIdx = args.indexOf("-d");
      void (async () => {
        if (dIdx !== -1) {
          const outDir = args[dIdx + 1];
          await mkdir(outDir, { recursive: true });
          await writeFile(join(outDir, "index.html"), "<html></html>");
        }
        handle.close(0);
      })();
      return handle.child as unknown as ReturnType<typeof spawn>;
    });

    const project = makeProject(workDir);
    const result = await generateDocs(project, {});

    expect(result.outputPath).toBe(join(workDir, "docs", "testplugin-1.0.0"));
    expect(result.fileCount).toBeGreaterThan(0);
    expect(result.sizeBytes).toBeGreaterThan(0);

    expect(spawn).toHaveBeenCalledTimes(1);
    const [cmd, args] = vi.mocked(spawn).mock.calls[0];
    // resolveJavadocBinary derives the path from javacPath; the mock returns
    // `"javac"` (PATH lookup), which becomes `"javadoc"`.
    expect(cmd).toBe("javadoc");
    const argv = args as string[];
    expect(argv[argv.indexOf("--release") + 1]).toBe("21");
    expect(argv).toContain(join(workDir, "src", "com", "example", "Main.java"));
    // Default access is -protected (not --private) when no flag passed.
    expect(argv).toContain("-protected");
    expect(argv).not.toContain("-private");
  });

  test("--clean wipes the output directory before generating", async () => {
    await mkdir(join(workDir, "src"), { recursive: true });
    await writeFile(join(workDir, "src", "Foo.java"), "class Foo {}");

    // Pre-existing output with a stale file.
    const outDir = join(workDir, "docs", "testplugin-1.0.0");
    await mkdir(outDir, { recursive: true });
    await writeFile(join(outDir, "stale.html"), "STALE");

    vi.mocked(spawn).mockImplementation((_cmd: unknown, _args: unknown) => {
      const args = _args as string[];
      const handle = fakeChild();
      const dIdx = args.indexOf("-d");
      void (async () => {
        if (dIdx !== -1) {
          const dest = args[dIdx + 1];
          await mkdir(dest, { recursive: true });
          await writeFile(join(dest, "index.html"), "<html></html>");
        }
        handle.close(0);
      })();
      return handle.child as unknown as ReturnType<typeof spawn>;
    });

    await generateDocs(makeProject(workDir), { clean: true });

    // stale.html must be gone — only files written by the (mocked) javadoc remain.
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(outDir);
    expect(entries).toContain("index.html");
    expect(entries).not.toContain("stale.html");
  });

  test("--access private surfaces as `-private`", async () => {
    await mkdir(join(workDir, "src"), { recursive: true });
    await writeFile(join(workDir, "src", "Foo.java"), "class Foo {}");

    vi.mocked(spawn).mockImplementation(() => {
      const h = fakeChild();
      h.close(0);
      return h.child as unknown as ReturnType<typeof spawn>;
    });

    await generateDocs(makeProject(workDir), { access: "private" });

    const argv = vi.mocked(spawn).mock.calls[0][1] as string[];
    expect(argv).toContain("-private");
    expect(argv).not.toContain("-protected");
  });

  test("propagates extra --link entries", async () => {
    await mkdir(join(workDir, "src"), { recursive: true });
    await writeFile(join(workDir, "src", "Foo.java"), "class Foo {}");

    vi.mocked(spawn).mockImplementation(() => {
      const h = fakeChild();
      h.close(0);
      return h.child as unknown as ReturnType<typeof spawn>;
    });

    await generateDocs(makeProject(workDir), {
      links: ["https://docs.oracle.com/en/java/javase/21/docs/api/"],
    });

    const argv = vi.mocked(spawn).mock.calls[0][1] as string[];
    const idx = argv.indexOf("-link");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(argv[idx + 1]).toBe("https://docs.oracle.com/en/java/javase/21/docs/api/");
  });

  test("throws when src/ contains no .java sources", async () => {
    await mkdir(join(workDir, "src"), { recursive: true });

    await expect(generateDocs(makeProject(workDir), {})).rejects.toThrow(/no \.java sources found/);
    expect(spawn).not.toHaveBeenCalled();
  });
});
