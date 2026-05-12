/** Contract tests for the parallel topological runner. */

import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import { initLogging, log } from "./logging.ts";
import type { ResolvedProject } from "./project.ts";
import { runWorkspaces } from "./runner.ts";
import type { WorkspaceNode } from "./workspace.ts";

function makeNode(name: string, deps: string[] = []): WorkspaceNode {
  return {
    name,
    root: `/tmp/${name}`,
    project: {
      name,
      version: "0.1.0",
      main: `com.example.${name}.Plugin`,
      compatibility: { versions: ["1.21"], platforms: ["paper"] },
      rootDir: `/tmp/${name}`,
      projectFile: `/tmp/${name}/project.json`,
      dependencies: Object.fromEntries(
        deps.map((d) => [d, { source: `workspace:${d}`, version: "*" }]),
      ),
    } as ResolvedProject,
  };
}

describe("runWorkspaces", () => {
  test("empty input returns empty output", async () => {
    const results = await runWorkspaces([], async () => "x");
    expect(results).toEqual([]);
  });

  test("linear chain runs in topological order", async () => {
    const a = makeNode("a");
    const b = makeNode("b", ["a"]);
    const c = makeNode("c", ["b"]);

    const order: string[] = [];
    const results = await runWorkspaces([c, b, a], async (node) => {
      order.push(node.name);
      return node.name.toUpperCase();
    });

    expect(order).toEqual(["a", "b", "c"]);
    expect(results.map((r) => r.workspace.name)).toEqual(["a", "b", "c"]);
    expect(results.every((r) => r.status === "ok")).toBe(true);
    expect(results.map((r) => r.value)).toEqual(["A", "B", "C"]);
  });

  test("independent workspaces run concurrently", async () => {
    const a = makeNode("a");
    const b = makeNode("b");

    let inFlight = 0;
    let peak = 0;
    const results = await runWorkspaces(
      [a, b],
      async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 10));
        inFlight--;
        return null;
      },
      { concurrency: 2 },
    );

    expect(peak).toBe(2);
    expect(results.every((r) => r.status === "ok")).toBe(true);
  });

  test("--concurrency 1 forces serial execution", async () => {
    const a = makeNode("a");
    const b = makeNode("b");

    let inFlight = 0;
    let peak = 0;
    await runWorkspaces(
      [a, b],
      async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return null;
      },
      { concurrency: 1 },
    );

    expect(peak).toBe(1);
  });

  test("diamond graph: shared dep runs once, leaves run concurrently", async () => {
    // a → b, a → c, b+c → d
    const a = makeNode("a");
    const b = makeNode("b", ["a"]);
    const c = makeNode("c", ["a"]);
    const d = makeNode("d", ["b", "c"]);

    const order: string[] = [];
    const results = await runWorkspaces(
      [a, b, c, d],
      async (node) => {
        order.push(node.name);
        return node.name;
      },
      { concurrency: 4 },
    );

    expect(order.indexOf("a")).toBeLessThan(order.indexOf("b"));
    expect(order.indexOf("a")).toBeLessThan(order.indexOf("c"));
    expect(order.indexOf("b")).toBeLessThan(order.indexOf("d"));
    expect(order.indexOf("c")).toBeLessThan(order.indexOf("d"));
    expect(results.every((r) => r.status === "ok")).toBe(true);
  });

  test("failure propagates to transitive dependents as skipped-upstream-failed", async () => {
    const a = makeNode("a");
    const b = makeNode("b", ["a"]);
    const c = makeNode("c", ["b"]);
    const independent = makeNode("indep");

    const results = await runWorkspaces([a, b, c, independent], async (node) => {
      if (node.name === "a") throw new Error("boom");
      return node.name;
    });

    const byName = Object.fromEntries(results.map((r) => [r.workspace.name, r]));
    expect(byName.a.status).toBe("failed");
    expect(byName.a.error?.message).toBe("boom");
    expect(byName.b.status).toBe("skipped-upstream-failed");
    expect(byName.c.status).toBe("skipped-upstream-failed");
    expect(byName.indep.status).toBe("ok");
  });

  test("skipOnUpstreamFailure:false lets dependents run even if upstream fails", async () => {
    const a = makeNode("a");
    const b = makeNode("b", ["a"]);

    const ran: string[] = [];
    const results = await runWorkspaces(
      [a, b],
      async (node) => {
        ran.push(node.name);
        if (node.name === "a") throw new Error("boom");
        return node.name;
      },
      { skipOnUpstreamFailure: false },
    );

    expect(ran).toContain("b");
    const byName = Object.fromEntries(results.map((r) => [r.workspace.name, r]));
    expect(byName.a.status).toBe("failed");
    expect(byName.b.status).toBe("ok");
  });

  test("failed workspace does not skip independent siblings", async () => {
    const failer = makeNode("failer");
    const ok = makeNode("ok");

    const results = await runWorkspaces([failer, ok], async (node) => {
      if (node.name === "failer") throw new Error("nope");
      return node.name;
    });

    const byName = Object.fromEntries(results.map((r) => [r.workspace.name, r]));
    expect(byName.failer.status).toBe("failed");
    expect(byName.ok.status).toBe("ok");
  });

  test("non-workspace deps in project.dependencies do not block ordering", async () => {
    const a = makeNode("a");
    // Tack on a modrinth dep that the runner should ignore.
    (a.project.dependencies as Record<string, unknown>)["worldedit"] = {
      source: "modrinth:worldedit",
      version: "7.3.15",
    };
    const b = makeNode("b", ["a"]);

    const order: string[] = [];
    await runWorkspaces([a, b], async (node) => {
      order.push(node.name);
      return node.name;
    });
    expect(order).toEqual(["a", "b"]);
  });

  test("workspace dep outside the selection is treated as already satisfied", async () => {
    const b = makeNode("b", ["a"]); // 'a' is NOT in the run set

    const results = await runWorkspaces([b], async (node) => node.name);
    expect(results[0].status).toBe("ok");
    expect(results[0].value).toBe("b");
  });

  describe("output buffering", () => {
    let stdoutSpy: ReturnType<typeof vi.spyOn>;
    let stderrSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      initLogging({ json: false, verbose: false, noColor: true });
      stdoutSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    });
    afterEach(() => {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    });

    test("buffers per-workspace output and flushes as a block when concurrency > 1", async () => {
      const a = makeNode("a");
      const b = makeNode("b");

      await runWorkspaces(
        [a, b],
        async (node) => {
          // Interleaved emits inside each runOne; buffering should keep
          // each workspace's lines contiguous in the final output.
          log.info(`${node.name}:1`);
          await new Promise((r) => setTimeout(r, 5));
          log.info(`${node.name}:2`);
          return null;
        },
        { concurrency: 2 },
      );

      const lines = stdoutSpy.mock.calls.map((c: unknown[]) => c[0] as string);
      const idxA1 = lines.indexOf("a:1");
      const idxA2 = lines.indexOf("a:2");
      const idxB1 = lines.indexOf("b:1");
      const idxB2 = lines.indexOf("b:2");

      // Each workspace's lines are contiguous (no interleaving).
      expect(idxA1).toBeGreaterThanOrEqual(0);
      expect(idxA2).toBeGreaterThanOrEqual(0);
      expect(idxB1).toBeGreaterThanOrEqual(0);
      expect(idxB2).toBeGreaterThanOrEqual(0);
      expect(idxA2 - idxA1).toBe(1);
      expect(idxB2 - idxB1).toBe(1);
    });

    test("bufferOutput:false streams output live even with concurrency > 1", async () => {
      const a = makeNode("a");
      const b = makeNode("b");

      await runWorkspaces(
        [a, b],
        async (node) => {
          log.info(`${node.name}:1`);
          await new Promise((r) => setTimeout(r, 5));
          log.info(`${node.name}:2`);
          return null;
        },
        { concurrency: 2, bufferOutput: false },
      );

      const lines = stdoutSpy.mock.calls.map((c: unknown[]) => c[0] as string);
      expect(lines).toContain("a:1");
      expect(lines).toContain("b:1");
    });

    test("buffered output still flushes on workspace failure", async () => {
      const a = makeNode("a");

      const results = await runWorkspaces(
        [a],
        async () => {
          log.info("about to fail");
          throw new Error("boom");
        },
        { concurrency: 2, bufferOutput: true },
      );

      expect(results[0].status).toBe("failed");
      const lines = stdoutSpy.mock.calls.map((c: unknown[]) => c[0] as string);
      expect(lines).toContain("about to fail");
    });
  });

  test("non-Error throw is wrapped into an Error", async () => {
    const a = makeNode("a");
    const results = await runWorkspaces([a], async () => {
      throw "string-thrown";
    });
    expect(results[0].status).toBe("failed");
    expect(results[0].error).toBeInstanceOf(Error);
    expect(results[0].error?.message).toBe("string-thrown");
  });
});
