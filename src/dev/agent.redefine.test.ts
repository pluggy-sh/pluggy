import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { copyFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import { createControlServer, ensureDevAgent, type ControlServer } from "./agent.ts";

const toolchain = ["javac", "java"].every((c) => spawnSync(c, ["-version"]).status === 0);

const SAMPLE_V1 = "package sample; public class Sample { public int value() { return 1; } }";
const SAMPLE_V2 = "package sample; public class Sample { public int value() { return 2; } }";
const EXTRA_V1 = "package sample; public class Extra { public int v() { return 1; } }";
const EXTRA_V2 = "package sample; public class Extra { public int v() { return 2; } }";
const HOLD =
  'package sample; public class Hold { public static void main(String[] a) throws Exception { new Sample(); System.out.println("READY"); Thread.sleep(60000); } }';

function javac(sources: string[], outDir: string): void {
  const result = spawnSync("javac", ["--release", "8", "-d", outDir, ...sources], {
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`javac failed: ${result.stderr}`);
}

// Needs a JDK to compile and run the sample; skip where it isn't present.
describe.skipIf(!toolchain)("agent redefine (real JVM)", () => {
  let work: string;
  let agentJar: string;
  let control: ControlServer;
  let child: ChildProcess;

  beforeAll(async () => {
    work = await mkdtemp(join(tmpdir(), "pluggy-agent-"));
    const src = join(work, "src", "sample");
    const classes = join(work, "classes");
    const v2s = join(work, "v2s");
    const v2e = join(work, "v2e");
    await mkdir(src, { recursive: true });
    await Promise.all([
      writeFile(join(src, "Sample.java"), SAMPLE_V1),
      writeFile(join(src, "Extra.java"), EXTRA_V1),
      writeFile(join(src, "Hold.java"), HOLD),
    ]);
    javac([join(src, "Sample.java"), join(src, "Extra.java"), join(src, "Hold.java")], classes);
    await writeFile(join(src, "Sample.java"), SAMPLE_V2);
    javac([join(src, "Sample.java")], v2s);
    await writeFile(join(src, "Extra.java"), EXTRA_V2);
    javac([join(src, "Extra.java")], v2e);

    agentJar = await ensureDevAgent();
    control = await createControlServer();
    child = spawn(
      "java",
      [
        `-javaagent:${agentJar}=roots=sample@${classes}`,
        `-Dpluggy.agent.port=${control.port}`,
        `-Dpluggy.agent.token=${control.token}`,
        "-cp",
        `${classes}${delimiter}${agentJar}`,
        "sample.Hold",
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    await new Promise<void>((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error("server never printed READY")), 20000);
      let buf = "";
      child.stdout?.on("data", (d: Buffer) => {
        buf += d.toString();
        if (buf.includes("READY")) {
          clearTimeout(timer);
          resolvePromise();
        }
      });
    });
  }, 40000);

  afterAll(async () => {
    control?.close();
    child?.kill();
    if (work !== undefined) await rm(work, { recursive: true, force: true });
  });

  test("distinguishes nochange, reloaded, and pending over the control socket", async () => {
    // The Control thread connects in premain, which runs before Hold's main;
    // poll until the first reply arrives to be sure the agent is attached.
    let first = { status: "disconnected" } as Awaited<ReturnType<ControlServer["reload"]>>;
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && first.status === "disconnected") {
      first = await control.reload(2000);
      if (first.status === "disconnected") await sleep(100);
    }
    expect(first.status).toBe("nochange");

    copyFileSync(
      join(work, "v2s", "sample", "Sample.class"),
      join(work, "classes", "sample", "Sample.class"),
    );
    expect(await control.reload(4000)).toMatchObject({ status: "reloaded", count: 1 });

    copyFileSync(
      join(work, "v2e", "sample", "Extra.class"),
      join(work, "classes", "sample", "Extra.class"),
    );
    expect(await control.reload(4000)).toMatchObject({ status: "pending", count: 1 });
  }, 20000);
});
