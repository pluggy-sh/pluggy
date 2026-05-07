/** Tests for src/dev/stage.ts. */

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";

import type { ResolvedProject } from "../project.ts";

import { stageDev } from "./stage.ts";

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

describe("stageDev", () => {
  let workDir: string;
  let serverJar: string;
  let originalNoEula: string | undefined;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "pluggy-dev-stage-"));
    serverJar = join(workDir, "cache-server.jar");
    await writeFile(serverJar, "FAKE-SERVER-JAR");
    originalNoEula = process.env.PLUGGY_DEV_NO_EULA;
    delete process.env.PLUGGY_DEV_NO_EULA;
  });

  afterEach(async () => {
    if (originalNoEula === undefined) {
      delete process.env.PLUGGY_DEV_NO_EULA;
    } else {
      process.env.PLUGGY_DEV_NO_EULA = originalNoEula;
    }
    await rm(workDir, { recursive: true, force: true });
  });

  test("creates dev/ with server.jar, eula.txt, server.properties", async () => {
    const project = makeProject(workDir);

    const devDir = await stageDev(project, serverJar, { vanillaServerFiles: true });
    expect(devDir).toBe(join(workDir, "dev"));

    const linkedBytes = await readFile(join(devDir, "server.jar"), "utf8");
    expect(linkedBytes).toBe("FAKE-SERVER-JAR");

    const eula = await readFile(join(devDir, "eula.txt"), "utf8");
    expect(eula).toContain("pluggy");
    expect(eula).toContain("eula=true");
    const raw = await readFile(join(devDir, "eula.txt"));
    expect(raw.includes(Buffer.from("\r\n"))).toBe(false);

    const props = await readFile(join(devDir, "server.properties"), "utf8");
    expect(props).toContain("motd=testplugin dev");
    expect(props).toContain("online-mode=false");
    expect(props).toContain("server-port=25565");
  });

  test("PLUGGY_DEV_NO_EULA=1 skips writing eula.txt", async () => {
    process.env.PLUGGY_DEV_NO_EULA = "1";
    const project = makeProject(workDir);
    const devDir = await stageDev(project, serverJar, { vanillaServerFiles: true });

    await stat(join(devDir, "server.properties"));
    await expect(stat(join(devDir, "eula.txt"))).rejects.toThrow();
  });

  test("opts.port overrides project.dev.port and the default", async () => {
    const project = makeProject(workDir, { dev: { port: 30000 } });

    const devDir = await stageDev(project, serverJar, { port: 25570, vanillaServerFiles: true });
    const props = await readFile(join(devDir, "server.properties"), "utf8");
    expect(props).toContain("server-port=25570");
    expect(props).not.toContain("server-port=30000");
    expect(props).not.toContain("server-port=25565");
  });

  test("project.dev.serverProperties can override defaults and add new keys", async () => {
    const project = makeProject(workDir, {
      dev: {
        serverProperties: {
          motd: "custom",
          difficulty: "peaceful",
          "spawn-protection": "0",
        },
      },
    });

    const devDir = await stageDev(project, serverJar, { vanillaServerFiles: true });
    const props = await readFile(join(devDir, "server.properties"), "utf8");
    expect(props).toContain("motd=custom");
    expect(props).not.toContain("motd=testplugin dev");
    expect(props).toContain("difficulty=peaceful");
    expect(props).toContain("spawn-protection=0");
  });

  test("clean wipes existing dev/", async () => {
    const devDir = join(workDir, "dev");
    await mkdir(join(devDir, "world"), { recursive: true });
    await writeFile(join(devDir, "world", "level.dat"), "OLD-WORLD");
    await writeFile(join(devDir, "leftover.txt"), "bye");

    const project = makeProject(workDir);
    await stageDev(project, serverJar, { clean: true, vanillaServerFiles: true });

    await expect(stat(join(devDir, "world"))).rejects.toThrow();
    await expect(stat(join(devDir, "leftover.txt"))).rejects.toThrow();
    await stat(join(devDir, "server.jar"));
  });

  test("freshWorld removes world* dirs but keeps everything else", async () => {
    const devDir = join(workDir, "dev");
    await mkdir(join(devDir, "world"), { recursive: true });
    await mkdir(join(devDir, "world_nether"), { recursive: true });
    await mkdir(join(devDir, "world_the_end"), { recursive: true });
    await mkdir(join(devDir, "plugins"), { recursive: true });
    await writeFile(join(devDir, "world", "level.dat"), "OLD-WORLD");
    await writeFile(join(devDir, "plugins", "debug.jar"), "KEEP");
    await writeFile(join(devDir, "logs.txt"), "keep-me");

    const project = makeProject(workDir);
    await stageDev(project, serverJar, { freshWorld: true, vanillaServerFiles: true });

    await expect(stat(join(devDir, "world"))).rejects.toThrow();
    await expect(stat(join(devDir, "world_nether"))).rejects.toThrow();
    await expect(stat(join(devDir, "world_the_end"))).rejects.toThrow();
    const kept = await readFile(join(devDir, "plugins", "debug.jar"), "utf8");
    expect(kept).toBe("KEEP");
    const logs = await readFile(join(devDir, "logs.txt"), "utf8");
    expect(logs).toBe("keep-me");
  });

  test("onlineMode option overrides project.dev.onlineMode", async () => {
    const project = makeProject(workDir, { dev: { onlineMode: true } });
    const devDir = await stageDev(project, serverJar, {
      onlineMode: false,
      vanillaServerFiles: true,
    });
    const props = await readFile(join(devDir, "server.properties"), "utf8");
    expect(props).toContain("online-mode=false");
  });

  test("server.properties is LF only", async () => {
    const project = makeProject(workDir);
    const devDir = await stageDev(project, serverJar, { vanillaServerFiles: true });
    const raw = await readFile(join(devDir, "server.properties"));
    expect(raw.includes(Buffer.from("\r\n"))).toBe(false);
  });

  test("vanillaServerFiles=false skips eula.txt and server.properties (proxies)", async () => {
    const project = makeProject(workDir);
    const devDir = await stageDev(project, serverJar, { vanillaServerFiles: false });

    await stat(join(devDir, "server.jar"));
    await expect(stat(join(devDir, "eula.txt"))).rejects.toThrow();
    await expect(stat(join(devDir, "server.properties"))).rejects.toThrow();
  });
});
