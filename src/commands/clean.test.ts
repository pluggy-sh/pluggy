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

  test("--docs removes only generated docs/<name>-<version>/ dirs, keeps foreign entries", async () => {
    await writeMulti();
    await mkdir(join(rootDir, "api", "docs", "api-0.1.0"), { recursive: true });
    await writeFile(join(rootDir, "api", "docs", "api-0.1.0", "index.html"), "x");
    await mkdir(join(rootDir, "api", "docs", "api-0.2.0-beta1"), { recursive: true });
    await mkdir(join(rootDir, "api", "docs", "other-1.0.0"), { recursive: true });
    await writeFile(join(rootDir, "api", "docs", "notes.md"), "keep me");

    const res = await runCleanCommand({ cwd: rootDir, target: "all" });
    // api/bin + core/bin + the two api-* generated docs dirs
    expect(res.removed?.length).toBe(4);
    expect(res.skippedDocs?.sort()).toEqual([
      join(rootDir, "api", "docs", "notes.md"),
      join(rootDir, "api", "docs", "other-1.0.0"),
    ]);
    await expect(stat(join(rootDir, "api", "docs", "api-0.1.0"))).rejects.toThrow();
    await expect(stat(join(rootDir, "api", "docs", "api-0.2.0-beta1"))).rejects.toThrow();
    await stat(join(rootDir, "api", "docs", "notes.md"));
    await stat(join(rootDir, "api", "docs", "other-1.0.0"));
  });

  test("--docs matches the workspace's exact version even when the shape regex does not", async () => {
    await writeFile(
      join(rootDir, "project.json"),
      JSON.stringify({
        name: "solo",
        version: "1.0.0-beta.1",
        main: "com.example.M",
        compatibility: { versions: ["1.21"], platforms: ["paper"] },
      }),
    );
    await mkdir(join(rootDir, "docs", "solo-1.0.0-beta.1"), { recursive: true });
    await writeFile(join(rootDir, "docs", "solo-1.0.0-beta.1", "index.html"), "x");

    const res = await runCleanCommand({ cwd: rootDir, target: "all" });
    expect(res.removed).toContain(join(rootDir, "docs", "solo-1.0.0-beta.1"));
    expect(res.skippedDocs).toBeUndefined();
    await expect(stat(join(rootDir, "docs", "solo-1.0.0-beta.1"))).rejects.toThrow();
  });

  test("--docs removes the docs/ dir itself once only generated output remains", async () => {
    await writeMulti();
    await mkdir(join(rootDir, "api", "docs", "api-0.1.0"), { recursive: true });
    await writeFile(join(rootDir, "api", "docs", "api-0.1.0", "index.html"), "x");

    const res = await runCleanCommand({ cwd: rootDir, target: "all" });
    expect(res.skippedDocs).toBeUndefined();
    await expect(stat(join(rootDir, "api", "docs"))).rejects.toThrow();
  });

  test("--docs --dry-run reports generated docs without touching disk", async () => {
    await writeMulti();
    await mkdir(join(rootDir, "api", "docs", "api-0.1.0"), { recursive: true });

    const res = await runCleanCommand({ cwd: rootDir, target: "all", dryRun: true });
    expect(res.wouldRemove).toContain(join(rootDir, "api", "docs", "api-0.1.0"));
    await stat(join(rootDir, "api", "docs", "api-0.1.0"));
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

  test("outside a project: UserError with E_CLEAN_NO_PROJECT", async () => {
    await expect(runCleanCommand({ cwd: rootDir })).rejects.toMatchObject({
      code: "E_CLEAN_NO_PROJECT",
    });
  });
});
