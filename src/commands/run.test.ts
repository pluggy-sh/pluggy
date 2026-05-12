/** Contract tests for `pluggy run`. */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";

import { initLogging } from "../logging.ts";
import { runRunCommand, tokenize } from "./run.ts";

describe("tokenize", () => {
  test("splits on whitespace", () => {
    expect(tokenize("echo a b")).toEqual(["echo", "a", "b"]);
  });

  test("groups double-quoted segments", () => {
    expect(tokenize(`echo "a b" c`)).toEqual(["echo", "a b", "c"]);
  });

  test("unescapes backslashes inside quotes", () => {
    expect(tokenize(`echo "a\\"b"`)).toEqual(["echo", `a"b`]);
  });

  test("empty string yields no tokens", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize("   ")).toEqual([]);
  });
});

describe("runRunCommand", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "pluggy-run-"));
    initLogging({ json: false, verbose: false, noColor: true });
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  test("no script name: lists scripts across workspaces", async () => {
    await writeFile(
      join(rootDir, "project.json"),
      JSON.stringify({
        name: "solo",
        version: "1.0.0",
        main: "com.example.M",
        compatibility: { versions: ["1.21"], platforms: ["paper"] },
        scripts: { greet: "echo hi", count: "echo 1" },
      }),
    );

    const res = await runRunCommand({ cwd: rootDir });
    expect(res.status).toBe("list");
    expect(res.scripts).toBeDefined();
    expect(res.scripts?.map((s) => s.name).sort()).toEqual(["count", "greet"]);
  });

  test("runs the named script in a standalone project", async () => {
    await writeFile(
      join(rootDir, "project.json"),
      JSON.stringify({
        name: "solo",
        version: "1.0.0",
        main: "com.example.M",
        compatibility: { versions: ["1.21"], platforms: ["paper"] },
        scripts: { ok: 'node -e "process.exit(0)"' },
      }),
    );

    const res = await runRunCommand({ cwd: rootDir, scriptName: "ok" });
    expect(res.status).toBe("success");
    expect(res.results).toHaveLength(1);
    expect(res.results![0].ok).toBe(true);
    expect(res.results![0].exitCode).toBe(0);
  });

  test("non-zero exit surfaces as failure", async () => {
    await writeFile(
      join(rootDir, "project.json"),
      JSON.stringify({
        name: "solo",
        version: "1.0.0",
        main: "com.example.M",
        compatibility: { versions: ["1.21"], platforms: ["paper"] },
        scripts: { fail: 'node -e "process.exit(3)"' },
      }),
    );

    // Single-target failure rethrows for the top-level handler.
    await expect(runRunCommand({ cwd: rootDir, scriptName: "fail" })).rejects.toThrow();
  });

  test("inherits scripts from root", async () => {
    await mkdir(join(rootDir, "api"), { recursive: true });
    await writeFile(
      join(rootDir, "project.json"),
      JSON.stringify({
        name: "suite",
        version: "1.0.0",
        compatibility: { versions: ["1.21"], platforms: ["paper"] },
        workspaces: ["./api"],
        scripts: { hello: "node -e \"console.log('hi')\"" },
      }),
    );
    await writeFile(
      join(rootDir, "api", "project.json"),
      JSON.stringify({ name: "api", version: "0.1.0" }),
    );

    const res = await runRunCommand({ cwd: rootDir, scriptName: "hello" });
    expect(res.status).toBe("success");
    expect(res.results).toHaveLength(1);
    expect(res.results![0].workspace).toBe("api");
  });

  test("workspace can override an inherited script", async () => {
    await mkdir(join(rootDir, "api"), { recursive: true });
    await writeFile(
      join(rootDir, "project.json"),
      JSON.stringify({
        name: "suite",
        version: "1.0.0",
        compatibility: { versions: ["1.21"], platforms: ["paper"] },
        workspaces: ["./api"],
        scripts: { lint: 'node -e "process.exit(99)"' },
      }),
    );
    await writeFile(
      join(rootDir, "api", "project.json"),
      JSON.stringify({
        name: "api",
        version: "0.1.0",
        scripts: { lint: 'node -e "process.exit(0)"' },
      }),
    );

    const res = await runRunCommand({ cwd: rootDir, scriptName: "lint" });
    expect(res.status).toBe("success");
    expect(res.results![0].exitCode).toBe(0);
  });

  test("null-valued script in workspace removes inherited entry", async () => {
    await mkdir(join(rootDir, "api"), { recursive: true });
    await writeFile(
      join(rootDir, "project.json"),
      JSON.stringify({
        name: "suite",
        version: "1.0.0",
        compatibility: { versions: ["1.21"], platforms: ["paper"] },
        workspaces: ["./api"],
        scripts: { lint: 'node -e "process.exit(0)"' },
      }),
    );
    await writeFile(
      join(rootDir, "api", "project.json"),
      JSON.stringify({
        name: "api",
        version: "0.1.0",
        scripts: { lint: null },
      }),
    );

    // No workspace ends up with a `lint` script after the null opts out.
    await expect(runRunCommand({ cwd: rootDir, scriptName: "lint" })).rejects.toThrow(
      /not defined/,
    );
  });

  test("variable substitution: ${project.name} and ${workspace.rootDir}", async () => {
    await writeFile(
      join(rootDir, "project.json"),
      JSON.stringify({
        name: "solo",
        version: "1.2.3",
        main: "com.example.M",
        compatibility: { versions: ["1.21"], platforms: ["paper"] },
        scripts: { show: "node -e \"console.log('${project.name}@${project.version}')\"" },
      }),
    );

    const res = await runRunCommand({ cwd: rootDir, scriptName: "show" });
    expect(res.status).toBe("success");
    expect(res.results![0].expanded.join(" ")).toContain("solo@1.2.3");
  });

  test("unknown script name throws with a helpful message", async () => {
    await writeFile(
      join(rootDir, "project.json"),
      JSON.stringify({
        name: "solo",
        version: "1.0.0",
        main: "com.example.M",
        compatibility: { versions: ["1.21"], platforms: ["paper"] },
        scripts: { hello: "echo hi" },
      }),
    );

    await expect(runRunCommand({ cwd: rootDir, scriptName: "nope" })).rejects.toThrow(
      /not defined/,
    );
  });

  test("extraArgs append to the tokenized script argv", async () => {
    await writeFile(
      join(rootDir, "project.json"),
      JSON.stringify({
        name: "solo",
        version: "1.0.0",
        main: "com.example.M",
        compatibility: { versions: ["1.21"], platforms: ["paper"] },
        scripts: { echo: "node -e \"console.log(process.argv.slice(1).join('|'))\"" },
      }),
    );

    const res = await runRunCommand({
      cwd: rootDir,
      scriptName: "echo",
      extraArgs: ["one", "two three"],
    });
    expect(res.status).toBe("success");
    // The expanded argv records what was passed through to the child.
    expect(res.results![0].expanded.slice(-2)).toEqual(["one", "two three"]);
  });

  test("throws when not inside any pluggy project", async () => {
    await expect(runRunCommand({ cwd: rootDir, scriptName: "x" })).rejects.toThrow(
      /no pluggy project/i,
    );
  });
});
