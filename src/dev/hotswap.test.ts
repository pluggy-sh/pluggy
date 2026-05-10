/**
 * Contract tests for the HotswapAgent helper module. Pure-fn tests live
 * here; the network-dependent `ensureAgent` is exercised in
 * `hotswap.network.test.ts` (matching the codebase's pattern of hitting
 * real upstreams rather than mocking them).
 */

import { EventEmitter } from "node:events";
import { afterEach, describe, expect, test } from "vite-plus/test";

import { agentJvmArgs, renderPropertiesFile, start, type HotswapWatcher } from "./hotswap.ts";

describe("renderPropertiesFile", () => {
  test("emits LOGGER, extraClasspath, and autoHotswap with the given classes dir", () => {
    const out = renderPropertiesFile({ classesDir: "/abs/path/to/classes" });
    expect(out).toContain("LOGGER=info");
    expect(out).toContain("extraClasspath=/abs/path/to/classes");
    expect(out).toContain("autoHotswap=true");
  });

  test("respects the logLevel override", () => {
    const out = renderPropertiesFile({ classesDir: "/x", logLevel: "debug" });
    expect(out).toContain("LOGGER=debug");
  });

  test("normalizes Windows-style backslashes; Java properties parser would otherwise eat them", () => {
    const out = renderPropertiesFile({
      classesDir: "C:\\Users\\dev\\.pluggy-build\\abc",
    });
    expect(out).toContain("extraClasspath=C:/Users/dev/.pluggy-build/abc");
    expect(out).not.toContain("\\");
  });
});

describe("agentJvmArgs", () => {
  test("emits javaagent + DCEVM enable + the --add-opens HA needs on Java 17+", () => {
    const args = agentJvmArgs({ agentJarPath: "/cache/agents/hotswap-agent-2.0.3.jar" });
    expect(args[0]).toBe("-javaagent:/cache/agents/hotswap-agent-2.0.3.jar");
    expect(args).toContain("-XX:+AllowEnhancedClassRedefinition");
    expect(args).toContain("--add-opens=java.base/java.lang=ALL-UNNAMED");
    expect(args).toContain("--add-opens=java.base/jdk.internal.loader=ALL-UNNAMED");
    expect(args).toContain("--add-opens=java.base/java.net=ALL-UNNAMED");
  });
});

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
}

function makeFakeChild(): FakeChild {
  const ee = new EventEmitter() as FakeChild;
  ee.stdout = new EventEmitter();
  ee.stderr = new EventEmitter();
  return ee;
}

describe("start (stdout marker watcher)", () => {
  let watcher: HotswapWatcher | undefined;

  afterEach(() => {
    watcher?.stop();
    watcher = undefined;
  });

  test("resolves 'reloaded' when HotswapAgent's success marker is observed on stdout", async () => {
    const child = makeFakeChild();
    watcher = start({
      child: child as unknown as Parameters<typeof start>[0]["child"],
      timeoutMs: 1000,
    });
    const pending = watcher.wait();
    child.stdout.emit(
      "data",
      "HOTSWAP AGENT: 12:34:56.789 RELOAD (PluginManager) - Reloading classes [com.example.Foo] (autoHotswap)\n",
    );
    expect(await pending).toBe("reloaded");
  });

  test("resolves 'failed' when HotswapAgent emits an ERROR line", async () => {
    const child = makeFakeChild();
    watcher = start({
      child: child as unknown as Parameters<typeof start>[0]["child"],
      timeoutMs: 1000,
    });
    const pending = watcher.wait();
    child.stdout.emit(
      "data",
      "HOTSWAP AGENT: 12:34:56.789 ERROR (...) - class redefinition failed: bad signature\n",
    );
    expect(await pending).toBe("failed");
  });

  test("resolves 'failed' on the JVM's UnsupportedOperationException for class redefinition", async () => {
    const child = makeFakeChild();
    watcher = start({
      child: child as unknown as Parameters<typeof start>[0]["child"],
      timeoutMs: 1000,
    });
    const pending = watcher.wait();
    child.stderr.emit(
      "data",
      "java.lang.UnsupportedOperationException: class redefinition failed: attempted to change schema\n",
    );
    expect(await pending).toBe("failed");
  });

  test("resolves 'timeout' when no marker arrives in time", async () => {
    const child = makeFakeChild();
    watcher = start({
      child: child as unknown as Parameters<typeof start>[0]["child"],
      timeoutMs: 30,
    });
    expect(await watcher.wait()).toBe("timeout");
  });

  test("ignores HotswapAgent's framework-plugin transformer ERRORs (Log4j2/Jackson/JdkPlugin)", async () => {
    const child = makeFakeChild();
    watcher = start({
      child: child as unknown as Parameters<typeof start>[0]["child"],
      timeoutMs: 80,
    });
    const pending = watcher.wait();
    child.stdout.emit(
      "data",
      "HOTSWAP AGENT: 10:31 ERROR (JdkPlugin) - flushBeanIntrospectorCaches() exception\n",
    );
    child.stdout.emit(
      "data",
      "HOTSWAP AGENT: 10:31 ERROR (Log4j2Plugin) - InvocationTargetException in transform method\n",
    );
    expect(await pending).toBe("timeout");
  });

  test("ignores unrelated server log lines", async () => {
    const child = makeFakeChild();
    watcher = start({
      child: child as unknown as Parameters<typeof start>[0]["child"],
      timeoutMs: 50,
    });
    const pending = watcher.wait();
    child.stdout.emit("data", '[Server] Done (1.234s)! For help, type "help"\n');
    child.stdout.emit("data", "Some other unrelated log line\n");
    expect(await pending).toBe("timeout");
  });

  test("buffers across chunk boundaries: a marker split mid-line still matches", async () => {
    const child = makeFakeChild();
    watcher = start({
      child: child as unknown as Parameters<typeof start>[0]["child"],
      timeoutMs: 500,
    });
    const pending = watcher.wait();
    child.stdout.emit("data", "HOTSWAP AGENT: 12:00 RELOAD (X) - Reload");
    child.stdout.emit("data", "ing classes [a.B] (autoHotswap)\n");
    expect(await pending).toBe("reloaded");
  });

  test("each wait() is independent: buffers reset between calls", async () => {
    const child = makeFakeChild();
    watcher = start({
      child: child as unknown as Parameters<typeof start>[0]["child"],
      timeoutMs: 200,
    });

    const first = watcher.wait();
    child.stdout.emit(
      "data",
      "HOTSWAP AGENT: 12:00 RELOAD - Reloading classes [a.B] (autoHotswap)\n",
    );
    expect(await first).toBe("reloaded");

    // Second wait must not match leftover data from the first.
    const second = watcher.wait();
    expect(await second).toBe("timeout");
  });

  test("arm() then a marker arriving BEFORE wait(): wait() resolves immediately (race fix)", async () => {
    const child = makeFakeChild();
    watcher = start({
      child: child as unknown as Parameters<typeof start>[0]["child"],
      timeoutMs: 200,
    });
    // Real-world race: HA emits RELOAD while the dev loop is still inside
    // buildProject. arm() was called before the rebuild, so the marker is
    // buffered; wait() picks it up afterwards without needing a fresh event.
    watcher.arm();
    child.stdout.emit(
      "data",
      "HOTSWAP AGENT: 10:30 RELOAD (PluginManager) - Reloading classes [com.example.Plugin] (autoHotswap)\n",
    );
    expect(await watcher.wait()).toBe("reloaded");
  });

  test("data arriving BEFORE arm() is dropped (out-of-band, doesn't carry over)", async () => {
    const child = makeFakeChild();
    watcher = start({
      child: child as unknown as Parameters<typeof start>[0]["child"],
      timeoutMs: 50,
    });
    // No arm() yet; emit a marker that should be ignored.
    child.stdout.emit(
      "data",
      "HOTSWAP AGENT: 10:30 RELOAD - Reloading classes [stale] (autoHotswap)\n",
    );
    watcher.arm();
    expect(await watcher.wait()).toBe("timeout");
  });

  test("stop() detaches listeners and is idempotent", () => {
    const child = makeFakeChild();
    watcher = start({
      child: child as unknown as Parameters<typeof start>[0]["child"],
      timeoutMs: 1000,
    });
    expect(child.stdout.listenerCount("data")).toBe(1);
    watcher.stop();
    expect(child.stdout.listenerCount("data")).toBe(0);
    // Idempotent: calling again must not throw or grow the count.
    watcher.stop();
    expect(child.stdout.listenerCount("data")).toBe(0);
  });
});
