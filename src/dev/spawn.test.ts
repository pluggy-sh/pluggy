/** Tests for src/dev/spawn.ts. `spawn` + `installShutdownHandler` mocked. */

import { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, spawn: vi.fn() };
});

vi.mock("../portable.ts", async () => {
  const actual = await vi.importActual<typeof import("../portable.ts")>("../portable.ts");
  return {
    ...actual,
    installShutdownHandler: vi.fn(() => (): void => {}),
  };
});

import { spawn } from "node:child_process";

import { installShutdownHandler } from "../portable.ts";

import { spawnServer } from "./spawn.ts";

interface FakeChild extends EventEmitter {
  stdin: NodeJS.WritableStream | null;
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  pid?: number;
  kill: () => boolean;
}

function makeFakeChild(): FakeChild {
  const ee = new EventEmitter() as FakeChild;
  const stdin = new EventEmitter() as unknown as NodeJS.WritableStream;
  (stdin as unknown as { destroyed: boolean }).destroyed = false;
  (stdin as unknown as { writable: boolean }).writable = true;
  (stdin as unknown as { write: (data: string) => boolean }).write = (): boolean => true;
  (stdin as unknown as { end: () => void }).end = (): void => {};
  ee.stdin = stdin;
  ee.stdout = null;
  ee.stderr = null;
  ee.pid = 4242;
  ee.kill = (): boolean => true;
  return ee;
}

describe("spawnServer", () => {
  beforeEach(() => {
    vi.mocked(spawn).mockReset();
    vi.mocked(installShutdownHandler).mockReset();
    vi.mocked(installShutdownHandler).mockReturnValue((): void => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("invokes `java -Xmx… jvmArgs -jar server.jar <serverArgs>` with cwd=devDir, stdin piped", () => {
    const fake = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(fake as unknown as ReturnType<typeof spawn>);

    const child = spawnServer({
      devDir: "/tmp/project/dev",
      serverJarName: "server.jar",
      memory: "2G",
      jvmArgs: ["-XX:+UseG1GC", "-XX:+ParallelRefProcEnabled"],
      serverArgs: ["nogui"],
    });

    expect(spawn).toHaveBeenCalledTimes(1);
    const [cmd, args, options] = vi.mocked(spawn).mock.calls[0];
    expect(cmd).toBe("java");
    expect(args).toEqual([
      "-Xmx2G",
      "-XX:+UseG1GC",
      "-XX:+ParallelRefProcEnabled",
      "-jar",
      "server.jar",
      "nogui",
    ]);
    expect((options as { cwd: string }).cwd).toBe("/tmp/project/dev");
    // pipes (not inherit) so the hotswap watcher can tap stdout/stderr while
    // the spawn helper still forwards them to the parent terminal.
    expect((options as { stdio: unknown }).stdio).toEqual(["pipe", "pipe", "pipe"]);

    expect(child).toBe(fake);
  });

  test("installs a shutdown handler with gracefulStdin=stop\\n, graceMs=30s, forceKill=2s", () => {
    const fake = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(fake as unknown as ReturnType<typeof spawn>);

    spawnServer({
      devDir: "/tmp/dev",
      serverJarName: "server.jar",
      memory: "1G",
      jvmArgs: [],
      serverArgs: ["nogui"],
    });

    expect(installShutdownHandler).toHaveBeenCalledTimes(1);
    const [childArg, optsArg] = vi.mocked(installShutdownHandler).mock.calls[0];
    expect(childArg).toBe(fake);
    expect(optsArg.gracefulStdin).toBe("stop\n");
    expect(optsArg.graceMs).toBe(30_000);
    expect(optsArg.forceKillWindowMs).toBe(2_000);
  });

  test("disposer is called when the child exits", () => {
    const fake = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(fake as unknown as ReturnType<typeof spawn>);
    const dispose = vi.fn();
    vi.mocked(installShutdownHandler).mockReturnValue(dispose);

    spawnServer({
      devDir: "/tmp/dev",
      serverJarName: "server.jar",
      memory: "1G",
      jvmArgs: [],
      serverArgs: ["nogui"],
    });

    expect(dispose).not.toHaveBeenCalled();
    fake.emit("exit", 0, null);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  test("memory gets interpolated into the first arg", () => {
    const fake = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(fake as unknown as ReturnType<typeof spawn>);

    spawnServer({
      devDir: "/tmp/dev",
      serverJarName: "server.jar",
      memory: "512M",
      jvmArgs: [],
      serverArgs: ["nogui"],
    });

    const args = vi.mocked(spawn).mock.calls[0][1] as string[];
    expect(args[0]).toBe("-Xmx512M");
  });

  test("serverJarName sits between -jar and the trailing serverArgs", () => {
    const fake = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(fake as unknown as ReturnType<typeof spawn>);

    spawnServer({
      devDir: "/tmp/dev",
      serverJarName: "paperclip-1.21.8.jar",
      memory: "4G",
      jvmArgs: ["-Dfoo=bar"],
      serverArgs: ["nogui"],
    });

    const args = vi.mocked(spawn).mock.calls[0][1] as string[];
    expect(args[args.length - 3]).toBe("-jar");
    expect(args[args.length - 2]).toBe("paperclip-1.21.8.jar");
    expect(args[args.length - 1]).toBe("nogui");
  });

  test("serverArgs are appended verbatim: empty array means no trailing args (proxies)", () => {
    const fake = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(fake as unknown as ReturnType<typeof spawn>);

    spawnServer({
      devDir: "/tmp/dev",
      serverJarName: "velocity.jar",
      memory: "1G",
      jvmArgs: [],
      serverArgs: [],
    });

    const args = vi.mocked(spawn).mock.calls[0][1] as string[];
    expect(args).toEqual(["-Xmx1G", "-jar", "velocity.jar"]);
  });

  test("serverArgs supports multi-value lists (e.g. sponge --nogui)", () => {
    const fake = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(fake as unknown as ReturnType<typeof spawn>);

    spawnServer({
      devDir: "/tmp/dev",
      serverJarName: "spongevanilla.jar",
      memory: "2G",
      jvmArgs: [],
      serverArgs: ["--nogui"],
    });

    const args = vi.mocked(spawn).mock.calls[0][1] as string[];
    expect(args).toEqual(["-Xmx2G", "-jar", "spongevanilla.jar", "--nogui"]);
  });
});
