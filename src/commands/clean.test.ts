/** Contract tests for `pluggy clean`. */

import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";

import { initLogging } from "../logging.ts";
import { runCleanCommand } from "./clean.ts";

describe("runCleanCommand", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "pluggy-clean-"));
    initLogging({ json: false, verbose: false, noColor: true });
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  async function writeMulti(): Promise<void> {
    await mkdir(join(rootDir, "api", "bin"), { recursive: true });
    await mkdir(join(rootDir, "core", "bin"), { recursive: true });
    await writeFile(
      join(rootDir, "project.json"),
      JSON.stringify({
        name: "suite",
        version: "1.0.0",
        compatibility: { versions: ["1.21"], platforms: ["paper"] },
        workspaces: ["./api", "./core"],
      }),
    );
    await writeFile(
      join(rootDir, "api", "project.json"),
      JSON.stringify({ name: "api", version: "0.1.0" }),
    );
    await writeFile(
      join(rootDir, "core", "project.json"),
      JSON.stringify({
        name: "core",
        version: "0.1.0",
        dependencies: { api: { source: "workspace:api", version: "*" } },
      }),
    );
    await writeFile(join(rootDir, "api", "bin", "old.jar"), "x");
    await writeFile(join(rootDir, "core", "bin", "old.jar"), "y");
  }

  test("sweeps bin/ across all workspaces by default", async () => {
    await writeMulti();
    const res = await runCleanCommand({ cwd: rootDir });
    expect(res.status).toBe("success");
    expect(res.removed).toHaveLength(2);
    await expect(stat(join(rootDir, "api", "bin"))).rejects.toThrow();
    await expect(stat(join(rootDir, "core", "bin"))).rejects.toThrow();
  });

  test("--workspace narrows to one", async () => {
    await writeMulti();
    const res = await runCleanCommand({ cwd: rootDir, workspace: ["api"] });
    expect(res.removed?.length).toBe(1);
    await expect(stat(join(rootDir, "api", "bin"))).rejects.toThrow();
    await stat(join(rootDir, "core", "bin")); // untouched
  });

  test("--exclude leaves the named workspace alone", async () => {
    await writeMulti();
    // 'core' depends on 'api', so excluding 'api' would orphan 'core';
    // excluding 'core' is the safe direction.
    const res = await runCleanCommand({ cwd: rootDir, exclude: ["core"] });
    expect(res.removed?.length).toBe(1);
    await expect(stat(join(rootDir, "api", "bin"))).rejects.toThrow();
    await stat(join(rootDir, "core", "bin"));
  });

  test("--dry-run reports wouldRemove without touching disk", async () => {
    await writeMulti();
    const res = await runCleanCommand({ cwd: rootDir, dryRun: true });
    expect(res.status).toBe("dry-run");
    expect(res.wouldRemove).toHaveLength(2);
    expect(res.removed).toBeUndefined();
    await stat(join(rootDir, "api", "bin"));
    await stat(join(rootDir, "core", "bin"));
  });

  test("--docs also removes docs/ output", async () => {
    await writeMulti();
    await mkdir(join(rootDir, "api", "docs"), { recursive: true });
    await writeFile(join(rootDir, "api", "docs", "index.html"), "x");

    const res = await runCleanCommand({ cwd: rootDir, docs: true });
    expect(res.removed?.length).toBe(3); // api/bin + api/docs + core/bin
    await expect(stat(join(rootDir, "api", "docs"))).rejects.toThrow();
  });

  test("standalone project: cleans the root bin/", async () => {
    await writeFile(
      join(rootDir, "project.json"),
      JSON.stringify({
        name: "solo",
        version: "1.0.0",
        main: "com.example.M",
        compatibility: { versions: ["1.21"], platforms: ["paper"] },
      }),
    );
    await mkdir(join(rootDir, "bin"), { recursive: true });
    await writeFile(join(rootDir, "bin", "out.jar"), "z");

    const res = await runCleanCommand({ cwd: rootDir });
    expect(res.removed?.length).toBe(1);
    await expect(stat(join(rootDir, "bin"))).rejects.toThrow();
  });

  test("no bin/ present: success, removed is empty", async () => {
    await writeFile(
      join(rootDir, "project.json"),
      JSON.stringify({
        name: "solo",
        version: "1.0.0",
        main: "com.example.M",
        compatibility: { versions: ["1.21"], platforms: ["paper"] },
      }),
    );
    const res = await runCleanCommand({ cwd: rootDir });
    expect(res.status).toBe("success");
    expect(res.removed).toHaveLength(0);
  });
});
