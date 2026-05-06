/**
 * Tests for src/dev/watch.ts. Stubs `node:fs/promises#watch` so change
 * events can be emitted synthetically, with no real filesystem watchers.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import type { ResolvedProject } from "../project.ts";

// Each mocked `watch()` call returns an AsyncIterable whose push queue lives
// in `controllers`; tests drive events via `emitEvent`.
interface FakeIter {
  push: (event: { eventType: string; filename: string }) => void;
  end: () => void;
  signal: AbortSignal;
  target: string;
}

const controllers: FakeIter[] = [];

function clearControllers(): void {
  controllers.length = 0;
}

function emitEvent(index = 0): void {
  controllers[index]?.push({ eventType: "change", filename: "file.java" });
}

function watchCount(): number {
  return controllers.length;
}

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    watch: vi.fn(
      (
        path: string,
        options?: { signal?: AbortSignal },
      ): AsyncIterable<{ eventType: string; filename: string }> => {
        const queue: Array<{ eventType: string; filename: string }> = [];
        let ended = false;
        let resolver: (() => void) | undefined;

        const signal = options?.signal ?? new AbortController().signal;

        signal.addEventListener?.("abort", () => {
          ended = true;
          resolver?.();
        });

        const iter: FakeIter = {
          target: path,
          signal,
          push: (evt) => {
            queue.push(evt);
            resolver?.();
          },
          end: () => {
            ended = true;
            resolver?.();
          },
        };
        controllers.push(iter);

        const asyncIter: AsyncIterable<{ eventType: string; filename: string }> = {
          [Symbol.asyncIterator](): AsyncIterator<{ eventType: string; filename: string }> {
            return {
              async next(): Promise<IteratorResult<{ eventType: string; filename: string }>> {
                while (true) {
                  if (queue.length > 0) {
                    return {
                      value: queue.shift() as { eventType: string; filename: string },
                      done: false,
                    };
                  }
                  if (ended || signal.aborted) {
                    const err = Object.assign(new Error("aborted"), { name: "AbortError" });
                    throw err;
                  }
                  await new Promise<void>((r) => {
                    resolver = r;
                  });
                  resolver = undefined;
                }
              },
            };
          },
        };
        return asyncIter;
      },
    ),
  };
});

import { watchProject } from "./watch.ts";

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

describe("watchProject", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "pluggy-dev-watch-"));
    // src/ and project.json must exist for collectWatchTargets to register any watchers.
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(workDir, "src"), { recursive: true });
    await writeFile(join(workDir, "project.json"), "{}");
    clearControllers();
  });

  afterEach(async () => {
    clearControllers();
    await rm(workDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  test("opens watchers for src/ and the project-file directory", async () => {
    const project = makeProject(workDir);
    const dispose = watchProject(project, {
      debounceMs: 10,
      onChange: async (): Promise<void> => {},
    });

    await new Promise((r) => setTimeout(r, 20));
    expect(watchCount()).toBeGreaterThanOrEqual(1);
    dispose();
  });

  test("coalesces bursts of events into one onChange", async () => {
    const onChange = vi.fn(async () => {});
    const project = makeProject(workDir);
    const dispose = watchProject(project, { debounceMs: 30, onChange });

    await new Promise((r) => setTimeout(r, 10));
    expect(watchCount()).toBeGreaterThan(0);

    emitEvent();
    emitEvent();
    emitEvent();

    await new Promise((r) => setTimeout(r, 80));

    expect(onChange).toHaveBeenCalledTimes(1);
    dispose();
  });

  test("onChange errors do not kill the watcher", async () => {
    let calls = 0;
    const onChange = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error("simulated build failure");
    });
    const project = makeProject(workDir);
    const dispose = watchProject(project, { debounceMs: 10, onChange });

    await new Promise((r) => setTimeout(r, 10));
    emitEvent();
    await new Promise((r) => setTimeout(r, 50));
    expect(onChange).toHaveBeenCalledTimes(1);

    emitEvent();
    await new Promise((r) => setTimeout(r, 50));
    expect(onChange).toHaveBeenCalledTimes(2);

    dispose();
  });

  test("disposer aborts watchers and cancels pending debounce", async () => {
    const onChange = vi.fn(async () => {});
    const project = makeProject(workDir);
    const dispose = watchProject(project, { debounceMs: 50, onChange });

    await new Promise((r) => setTimeout(r, 10));
    emitEvent();

    dispose();

    await new Promise((r) => setTimeout(r, 100));
    expect(onChange).not.toHaveBeenCalled();

    for (const c of controllers) {
      expect(c.signal.aborted).toBe(true);
    }
  });

  test("ignores non-project.json events from the project root", async () => {
    const onChange = vi.fn(async () => {});
    const project = makeProject(workDir);
    const dispose = watchProject(project, { debounceMs: 10, onChange });

    await new Promise((r) => setTimeout(r, 20));

    const rootWatcher = controllers.find((c) => c.target === workDir);
    expect(rootWatcher).toBeDefined();

    rootWatcher?.push({ eventType: "change", filename: "bin/repro-1.0.0.jar" });
    rootWatcher?.push({ eventType: "rename", filename: ".pluggy-build" });
    rootWatcher?.push({ eventType: "change", filename: "dev" });

    await new Promise((r) => setTimeout(r, 50));
    expect(onChange).not.toHaveBeenCalled();

    rootWatcher?.push({ eventType: "change", filename: "project.json" });
    await new Promise((r) => setTimeout(r, 50));
    expect(onChange).toHaveBeenCalledTimes(1);

    dispose();
  });

  test("includes resource paths in the watch set", async () => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(workDir, "i18n"), { recursive: true });
    await mkdir(join(workDir, "resources"), { recursive: true });
    await writeFile(join(workDir, "resources", "plugin.yml"), "x");

    const project = makeProject(workDir, {
      resources: {
        "plugin.yml": "./resources/plugin.yml",
        "lang/": "./i18n/",
      },
    });

    const dispose = watchProject(project, { debounceMs: 10, onChange: async () => {} });
    await new Promise((r) => setTimeout(r, 20));

    const targets = controllers.map((c) => c.target);
    expect(targets.some((t) => t.endsWith("src"))).toBe(true);
    expect(targets.some((t) => t.endsWith("i18n"))).toBe(true);
    expect(targets.some((t) => t.endsWith("resources"))).toBe(true);
    dispose();
  });
});
