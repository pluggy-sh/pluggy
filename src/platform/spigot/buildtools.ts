/**
 * Spigot BuildTools driver. Downloads `BuildTools.jar`, spawns it under
 * Java to compile a CraftBukkit or Spigot server jar, and surfaces the
 * child's live output as an async stream.
 *
 * SpigotMC publishes BuildTools.jar without a checksum sidecar, so we
 * can't bake an upstream-known hash in. Instead we apply trust-on-first-use
 * (TOFU): record the SHA-256 of the first download alongside the cached
 * jar, and refuse to use a cached copy whose bytes drift from the recorded
 * value on subsequent runs. Catches post-install substitution and partial
 * download even though the initial download is still trusted on its first
 * appearance.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { classMajorToJava } from "../../jar.ts";
import type { PlatformContext } from "../platform.ts";

const BUILDTOOLS_URL =
  "https://hub.spigotmc.org/jenkins/job/BuildTools/lastSuccessfulBuild/artifact/target/BuildTools.jar";
export const VERSIONS_URL = "https://hub.spigotmc.org/versions/";

/** Download (or reuse a cached copy of) `BuildTools.jar` and return its path. */
export async function download(ctx: PlatformContext, ignoreCache = false): Promise<string> {
  const BUILDTOOLS_PATH = join(ctx.getCachePath(), "BuildTools.jar");
  const SHA_PATH = `${BUILDTOOLS_PATH}.sha256`;

  if (existsSync(BUILDTOOLS_PATH) && !ignoreCache) {
    if (existsSync(SHA_PATH)) {
      const recorded = (await readFile(SHA_PATH, "utf8")).trim();
      const actual = createHash("sha256")
        .update(await readFile(BUILDTOOLS_PATH))
        .digest("hex");
      if (recorded !== actual) {
        // Cached jar drifted from the recorded hash: cache poisoning,
        // partial overwrite, or a bit-flip. Drop both files and re-fetch
        // so the user gets a fresh jar with a fresh recorded hash.
        await rm(BUILDTOOLS_PATH, { force: true });
        await rm(SHA_PATH, { force: true });
      } else {
        return BUILDTOOLS_PATH;
      }
    } else {
      // Older install (pre-TOFU): adopt the existing jar by recording
      // its current hash. Strictly weaker than a clean download, but the
      // user has already been running this jar so it's not a regression.
      const actual = createHash("sha256")
        .update(await readFile(BUILDTOOLS_PATH))
        .digest("hex");
      await writeFile(SHA_PATH, `${actual}\n`);
      return BUILDTOOLS_PATH;
    }
  }

  const res = await fetch(BUILDTOOLS_URL);
  if (!res.ok) throw new Error(`Failed to download BuildTools: ${res.statusText}`);
  const data = new Uint8Array(await res.arrayBuffer());
  const sha = createHash("sha256").update(data).digest("hex");
  await writeFile(BUILDTOOLS_PATH, data);
  await writeFile(SHA_PATH, `${sha}\n`);
  return BUILDTOOLS_PATH;
}

export type PlatformType = "craftbukkit" | "spigot" | "none";

/** Live handle for a running BuildTools compile. */
export type Compiler = {
  type: PlatformType;
  version: string;
  /** Async iterator of combined stdout+stderr lines from the child. */
  stream: AsyncGenerator<string>;
  /** Await the child's exit and return the final jar bytes. */
  output(): Promise<Uint8Array>;
};

/**
 * Spawn BuildTools to compile `type` at `version`. Returns immediately with
 * a handle; the caller iterates `stream` to tap output and awaits `output()`
 * to get the final jar bytes (which throws with the last stderr line if the
 * child exits non-zero or the expected jar is missing).
 */
export async function compile(
  ctx: PlatformContext,
  version: string,
  type: PlatformType = "craftbukkit",
  ignoreCache = false,
): Promise<Compiler> {
  const BUILDTOOLS_PATH = await download(ctx, ignoreCache);
  const BUILDTOOLS_CACHE = join(ctx.getCachePath(), "BuildTools");

  if (ignoreCache) await rm(BUILDTOOLS_CACHE, { recursive: true, force: true }).catch(() => {});
  await mkdir(BUILDTOOLS_CACHE, { recursive: true });

  const OUTPUT_JAR = join(BUILDTOOLS_CACHE, `${type}-${version}.jar`);

  const child = spawn(
    "java",
    [
      "-jar",
      BUILDTOOLS_PATH,
      "--rev",
      version,
      "--compile",
      type,
      "--final-name",
      `${type}-${version}.jar`,
    ],
    { cwd: BUILDTOOLS_CACHE, stdio: ["ignore", "pipe", "pipe"] },
  );

  const decoder = new TextDecoder();
  let lastError: string | null = null;
  let lastException: string | null = null;

  async function* readStream(
    stream: NodeJS.ReadableStream,
    source: "stdout" | "stderr",
  ): AsyncGenerator<{ source: string; text: string }> {
    for await (const chunk of stream) {
      const text = typeof chunk === "string" ? chunk : decoder.decode(chunk);
      if (source === "stderr") {
        if (text.includes("Exception")) lastException = text;
        lastError = text;
      }
      yield { source, text };
    }
  }

  const streams = [readStream(child.stdout!, "stdout"), readStream(child.stderr!, "stderr")];

  async function* read(): AsyncGenerator<string> {
    const nexts = streams.map((g, i) => g.next().then((r) => ({ ...r, i })));
    while (nexts.length) {
      const result = await Promise.race(nexts);
      if (result.done) {
        void nexts.splice(result.i, 1);
        continue;
      }
      yield result.value.text;
      nexts[result.i] = streams[result.i].next().then((r) => ({ ...r, i: result.i }));
    }
  }

  const exited = new Promise<number>((resolve) => {
    child.on("close", (code: number | null) => resolve(code ?? 1));
  });

  const stream = read();

  return {
    type,
    version,
    async output() {
      for await (const _ of stream) {
        // Drain so the child is allowed to exit.
      }
      const code = await exited;
      const ok = await stat(OUTPUT_JAR)
        .then(() => true)
        .catch(() => false);
      if (code === 0 && ok) {
        return new Uint8Array(readFileSync(OUTPUT_JAR));
      }
      throw new Error(
        `BuildTools failed to compile ${type} version ${version}\n${lastException || lastError || "No error message available"}`,
      );
    },
    stream,
  };
}

/**
 * Fetch a version's manifest from Spigot's hub and return the Java major
 * release range it declares (`javaVersions` is a class-file major range,
 * e.g. `[65, 70]` meaning Java 21 to 26). Returns `undefined` when the
 * manifest is missing, malformed, omits `javaVersions`, or the request
 * fails for any reason; `init` treats this as "unknown, fall through"
 * rather than a hard error, so this function never throws.
 *
 * A 5s abort guards against the OS-level TCP timeout (~75s) when Spigot's
 * hub is unreachable; without it init would hang per probed candidate.
 */
export async function getJavaRange(version: string): Promise<[number, number] | undefined> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  let data: unknown;
  try {
    const res = await fetch(`${VERSIONS_URL}${version}.json`, { signal: ctrl.signal });
    if (!res.ok) return undefined;
    data = await res.json();
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }

  if (data === null || typeof data !== "object") return undefined;
  const range = (data as { javaVersions?: unknown }).javaVersions;
  if (!Array.isArray(range)) return undefined;
  const min = range[0];
  const max = range[range.length - 1];
  if (typeof min !== "number" || typeof max !== "number") return undefined;
  return [classMajorToJava(min), classMajorToJava(max)];
}

/**
 * Scrape Spigot's version index and return versions ordered newest-first.
 * Results include `.json`-suffixed entries after stripping the extension.
 */
export async function versions(): Promise<string[]> {
  const res = await fetch(VERSIONS_URL);
  if (!res.ok) throw new Error(`Failed to fetch buildtools versions: ${res.statusText}`);

  const html = await res.text();
  const versions = Array.from(html.matchAll(/<a\s+href="([^"]+)"/g))
    .map((m) => m[1].split(".json")[0])
    .filter((v) => !v.includes("../"))
    .sort((a, b) => {
      if (!a.includes(".") || !b.includes(".")) return 1;
      const aParts = a.split("-")[0].split(".").map(Number);
      const bParts = b.split("-")[0].split(".").map(Number);
      return bParts[0] - aParts[0] || bParts[1] - aParts[1] || (bParts[2] ?? 0) - (aParts[2] ?? 0);
    });

  return versions;
}
