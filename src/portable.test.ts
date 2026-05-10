/** Contract tests for cross-platform helpers. */

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import {
  installShutdownHandler,
  linkOrCopy,
  resolveRelativeToConfig,
  safeJoin,
  toPosixPath,
  writeFileLF,
} from "./portable.ts";

describe("toPosixPath", () => {
  test("passes forward-slash input through unchanged", () => {
    expect(toPosixPath("a/b/c")).toBe("a/b/c");
    expect(toPosixPath("./libs/foo.jar")).toBe("./libs/foo.jar");
  });

  test("converts backslashes to forward slashes", () => {
    expect(toPosixPath("a\\b\\c")).toBe("a/b/c");
    expect(toPosixPath(".\\libs\\foo.jar")).toBe("./libs/foo.jar");
  });

  test("normalizes mixed separators", () => {
    expect(toPosixPath("a\\b/c")).toBe("a/b/c");
  });

  test("leaves absolute Windows drive paths functional", () => {
    expect(toPosixPath("C:\\Users\\foo")).toBe("C:/Users/foo");
  });
});

describe("linkOrCopy", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "pluggy-portable-link-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(workDir, { recursive: true, force: true });
  });

  test("happy path: destination has the same bytes as source", async () => {
    const source = join(workDir, "src.bin");
    const destination = join(workDir, "dst.bin");
    const payload = Buffer.from("pluggy-linkOrCopy-happy-path");
    await writeFile(source, payload);

    await linkOrCopy(source, destination);

    const read = await readFile(destination);
    expect(read.equals(payload)).toBe(true);
  });

  test("overwrites an existing destination (EEXIST handling)", async () => {
    const source = join(workDir, "src.bin");
    const destination = join(workDir, "dst.bin");
    await writeFile(source, "new-bytes");
    await writeFile(destination, "old-bytes");

    await linkOrCopy(source, destination);

    const read = await readFile(destination, "utf8");
    expect(read).toBe("new-bytes");
  });

  test("falls back to copyFile when link throws EXDEV", async () => {
    const source = join(workDir, "src.bin");
    const destination = join(workDir, "dst.bin");
    const payload = "cross-volume-fallback";
    await writeFile(source, payload);

    // vi.doMock: ESM named-export bindings aren't configurable, so vi.spyOn
    // fails on node:fs/promises. Dynamic re-import stubs `link` with EXDEV
    // while leaving `copyFile` real.
    vi.resetModules();
    const copySpy = vi.fn<(src: string, dst: string) => Promise<void>>(async (src, dst) => {
      const fsSync = await import("node:fs");
      fsSync.copyFileSync(src, dst);
    });
    const linkSpy = vi.fn(async () => {
      throw Object.assign(new Error("EXDEV: cross-device link not permitted"), {
        code: "EXDEV",
      });
    });

    vi.doMock("node:fs/promises", async () => {
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      return {
        ...actual,
        default: actual,
        link: linkSpy,
        copyFile: copySpy,
      };
    });

    try {
      const mod = await import("./portable.ts");
      await mod.linkOrCopy(source, destination);

      expect(linkSpy).toHaveBeenCalledTimes(1);
      expect(copySpy).toHaveBeenCalledTimes(1);
      const read = await readFile(destination, "utf8");
      expect(read).toBe(payload);

      // Confirm destination is an independent file, not a hardlink.
      const srcStat = await stat(source);
      const dstStat = await stat(destination);
      expect(dstStat.nlink).toBe(1);
      expect(srcStat.nlink).toBe(1);
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }
  });
});

describe("resolveRelativeToConfig", () => {
  const configFile = resolve("/tmp/project/project.json");

  test("resolves forward-slash relative input against the config dir", () => {
    const result = resolveRelativeToConfig(configFile, "./libs/foo.jar");
    expect(result).toBe(resolve("/tmp/project/libs/foo.jar"));
  });

  test("resolves backslash relative input against the config dir", () => {
    const result = resolveRelativeToConfig(configFile, ".\\libs\\foo.jar");
    expect(result).toBe(resolve("/tmp/project/libs/foo.jar"));
  });

  test("passes absolute input through (still OS-native)", () => {
    const abs = resolve("/tmp/other/lib.jar");
    const result = resolveRelativeToConfig(configFile, abs);
    expect(result).toBe(abs);
    expect(isAbsolute(result)).toBe(true);
  });

  test("returns an absolute path using OS separators", () => {
    const result = resolveRelativeToConfig(configFile, "libs/foo.jar");
    expect(isAbsolute(result)).toBe(true);
    expect(result.includes(sep)).toBe(true);
  });
});

describe("writeFileLF", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "pluggy-portable-lf-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  test("writes LF input as LF", async () => {
    const target = join(workDir, "out.txt");
    await writeFileLF(target, "one\ntwo\nthree\n");

    const raw = await readFile(target);
    expect(raw.includes(Buffer.from("\r\n"))).toBe(false);
    expect(raw.toString("utf8")).toBe("one\ntwo\nthree\n");
  });

  test("converts CRLF to LF on write", async () => {
    const target = join(workDir, "crlf.txt");
    await writeFileLF(target, "one\r\ntwo\r\nthree\r\n");

    const raw = await readFile(target);
    expect(raw.includes(Buffer.from("\r\n"))).toBe(false);
    expect(raw.toString("utf8")).toBe("one\ntwo\nthree\n");
  });

  test("round-trips cleanly via readFile", async () => {
    const target = join(workDir, "rt.txt");
    const contents = "alpha\nbeta\ngamma\n";
    await writeFileLF(target, contents);

    const read = await readFile(target, "utf8");
    expect(read).toBe(contents);
  });
});

describe("safeJoin", () => {
  const root = resolve("/tmp/pluggy-safe-root");

  test("joins a clean relative path", () => {
    expect(safeJoin(root, "files/a/b.txt")).toBe(resolve(root, "files/a/b.txt"));
  });

  test("rejects parent traversal", () => {
    expect(() => safeJoin(root, "../etc/passwd")).toThrow(/escapes/);
    expect(() => safeJoin(root, "files/../../etc/passwd")).toThrow(/escapes/);
    expect(() => safeJoin(root, "a/b/../../../etc/passwd")).toThrow(/escapes/);
  });

  test("rejects absolute paths", () => {
    expect(() => safeJoin(root, resolve("/etc/passwd"))).toThrow(/absolute/);
  });

  test("rejects backslash-bearing input on every host", () => {
    expect(() => safeJoin(root, "a\\b\\c")).toThrow(/backslash/);
    expect(() => safeJoin(root, "..\\etc\\passwd")).toThrow(/backslash/);
  });

  test("allows nested traversal that doesn't escape root", () => {
    expect(safeJoin(root, "a/../b.txt")).toBe(resolve(root, "b.txt"));
  });
});

describe("installShutdownHandler", () => {
  // Disposers kept here so afterEach always clears the SIGINT listener even
  // when a test fails before its own cleanup runs.
  const disposers: Array<() => void> = [];
  const spawnedChildren: Array<ReturnType<typeof spawn>> = [];

  afterEach(() => {
    while (disposers.length > 0) {
      const dispose = disposers.pop();
      try {
        dispose?.();
      } catch {
        // ignore
      }
    }
    for (const child of spawnedChildren) {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill("SIGKILL");
        } catch {
          // already dead
        }
      }
    }
    spawnedChildren.length = 0;
  });

  test("first Ctrl+C writes gracefulStdin and the child exits cleanly", async () => {
    const child = spawn(
      process.execPath,
      [
        "-e",
        "process.stdin.on('data', d => { if (d.toString().includes('STOP')) process.exit(0); });",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    spawnedChildren.push(child);

    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolvePromise) => {
        child.once("exit", (code, signal) => {
          resolvePromise({ code, signal });
        });
      },
    );

    const dispose = installShutdownHandler(child, {
      gracefulStdin: "STOP\n",
      graceMs: 2000,
      forceKillWindowMs: 2000,
    });
    disposers.push(dispose);

    // Wait for the child to attach its stdin listener.
    await new Promise((r) => setTimeout(r, 100));

    process.emit("SIGINT");

    const result = await exited;
    expect(result.code).toBe(0);
    expect(result.signal).toBeNull();

    dispose();
    disposers.pop();
  });

  test("child that ignores stdin is killed after graceMs elapses", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    spawnedChildren.push(child);

    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolvePromise) => {
        child.once("exit", (code, signal) => {
          resolvePromise({ code, signal });
        });
      },
    );

    const dispose = installShutdownHandler(child, {
      gracefulStdin: "STOP\n",
      graceMs: 300,
      forceKillWindowMs: 2000,
    });
    disposers.push(dispose);

    await new Promise((r) => setTimeout(r, 50));

    const start = Date.now();
    process.emit("SIGINT");

    const result = await exited;
    const elapsed = Date.now() - start;

    // Unix surfaces this as signal=SIGTERM; on Windows signal may be null and
    // code varies; either channel counts as evidence kill() fired.
    const wasKilled = result.signal !== null || result.code !== 0;
    expect(wasKilled).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(250);

    dispose();
    disposers.pop();
  });
});
