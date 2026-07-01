/**
 * The pluggy side of the hotswap agent: provisions the embedded agent jar,
 * builds its `-javaagent` args, and runs the loopback control socket the agent
 * connects back to. pluggy sends `reload`; the agent redefines the classes.
 */

import { createServer, type Server, type Socket } from "node:net";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { getCachePath } from "../project.ts";
import { toPosixPath } from "../portable.ts";

import { AGENT_JAR_BASE64, AGENT_JAR_SHA256 } from "./agent-jar.generated.ts";

/** Write the embedded agent jar to the cache (idempotent); return its path. */
export async function ensureDevAgent(): Promise<string> {
  const cacheDir = join(getCachePath(), "agents");
  const dest = join(cacheDir, `pluggy-agent-${AGENT_JAR_SHA256.slice(0, 12)}.jar`);
  if (existsSync(dest)) return dest;

  const bytes = Buffer.from(AGENT_JAR_BASE64, "base64");
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== AGENT_JAR_SHA256) {
    throw new Error(
      `Embedded dev agent failed its integrity check (expected ${AGENT_JAR_SHA256}, got ${actual}); ` +
        `regenerate with bun agent/build.ts.`,
    );
  }

  await mkdir(cacheDir, { recursive: true });
  const tmp = `${dest}.partial`;
  await writeFile(tmp, bytes);
  await rename(tmp, dest);
  return dest;
}

/**
 * Derive the package prefix the agent should redefine from a fully-qualified
 * main class. `com.example.PluggyTest2` → `com.example`. Returns `undefined`
 * for a default-package or missing main (the agent then redefines every
 * changed loaded class).
 */
export function watchedPackageFromMain(main: string | undefined): string | undefined {
  if (main === undefined || main.length === 0) return undefined;
  const dot = main.lastIndexOf(".");
  return dot > 0 ? main.slice(0, dot) : undefined;
}

/** One plugin the agent hotswaps: its exploded `.class` dir + package scope. */
export interface AgentRoot {
  /** The build's exploded `.class` directory the agent redefines from. */
  classesDir: string;
  /** Package prefix to scope this root's redefinition to (omit = all). */
  watchedPackage?: string;
}

export interface AgentJvmArgsInput {
  agentJarPath: string;
  /** One root per plugin sharing the server JVM (at least one). */
  roots: AgentRoot[];
  /** Control-socket port and nonce pluggy is listening on. */
  port: number;
  token: string;
}

/** JVM args that attach the agent and point it at the control socket + classes. */
export function agentJvmArgs(input: AgentJvmArgsInput): string[] {
  // roots=<pkg>@<dir>;<pkg>@<dir> — one per plugin; `;`/`@` never occur in a
  // posix path, so no escaping is needed.
  const roots = input.roots
    .map((r) => `${r.watchedPackage ?? ""}@${toPosixPath(r.classesDir)}`)
    .join(";");
  return [
    `-javaagent:${input.agentJarPath}=roots=${roots}`,
    // JBR's DCEVM: lets redefineClasses add methods/fields, not just bodies.
    "-XX:+AllowEnhancedClassRedefinition",
    // The agent reflects into URLClassLoader.addURL to splice the classes dir
    // into the plugin classloader (so a hotswap can introduce a new class);
    // Java 17+ needs java.net opened for that reflective setAccessible.
    "--add-opens=java.base/java.net=ALL-UNNAMED",
    `-Dpluggy.agent.port=${input.port}`,
    `-Dpluggy.agent.token=${input.token}`,
  ];
}

/** Outcome of a `reload` request, as reported by the agent over the socket. */
export interface ReloadResult {
  status:
    | "reloaded"
    | "pending"
    | "nochange"
    | "unsupported"
    | "error"
    | "timeout"
    | "disconnected";
  /**
   * For `reloaded`: classes redefined live. For `pending`: watched classes that
   * changed on disk but aren't loaded yet (new/unregistered code).
   */
  count?: number;
  /** Diagnostic detail (for `unsupported` / `error`). */
  message?: string;
}

/**
 * Loopback control server. Created once per dev session (survives server
 * restarts — the new JVM's agent reconnects). Single agent at a time: a new
 * connection replaces the previous one.
 */
export interface ControlServer {
  readonly port: number;
  readonly token: string;
  /** Send `reload`; resolve with the agent's result (or timeout/disconnected). */
  reload(timeoutMs: number): Promise<ReloadResult>;
  close(): void;
}

/** Start the loopback control server on an ephemeral port with a fresh nonce. */
export async function createControlServer(): Promise<ControlServer> {
  const token = randomBytes(16).toString("hex");

  let sock: Socket | undefined;
  let ready = false;
  let buffer = "";
  let replyResolve: ((line: string) => void) | undefined;

  const onLine = (line: string): void => {
    if (line.startsWith("hello\t")) {
      const parts = line.split("\t");
      if (parts[1] !== token) {
        sock?.destroy();
        sock = undefined;
        return;
      }
      ready = true;
      return;
    }
    if (replyResolve !== undefined) {
      const r = replyResolve;
      replyResolve = undefined;
      r(line);
    }
  };

  const server: Server = createServer((s) => {
    sock = s;
    ready = false;
    buffer = "";
    s.setEncoding("utf8");
    s.setNoDelay(true);
    s.on("data", (chunk: string) => {
      buffer += chunk;
      let nl = buffer.indexOf("\n");
      while (nl !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        onLine(line);
        nl = buffer.indexOf("\n");
      }
    });
    s.on("close", () => {
      if (sock === s) {
        sock = undefined;
        ready = false;
      }
    });
    // Swallow socket errors; the paired `close` handler does the cleanup.
    s.on("error", () => {});
  });

  await new Promise<void>((resolvePromise) => {
    server.listen(0, "127.0.0.1", () => resolvePromise());
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;

  return {
    port,
    token,
    reload(timeoutMs: number): Promise<ReloadResult> {
      const current = sock;
      if (current === undefined || !ready) return Promise.resolve({ status: "disconnected" });
      return new Promise<ReloadResult>((resolvePromise) => {
        const timer = setTimeout(() => {
          replyResolve = undefined;
          resolvePromise({ status: "timeout" });
        }, timeoutMs);
        timer.unref?.();
        replyResolve = (line: string): void => {
          clearTimeout(timer);
          resolvePromise(parseReply(line));
        };
        current.write("reload\n");
      });
    },
    close(): void {
      try {
        sock?.destroy();
      } catch {
        // already gone
      }
      sock = undefined;
      server.close();
    },
  };
}

function parseReply(line: string): ReloadResult {
  const tab = line.indexOf("\t");
  const status = tab === -1 ? line : line.slice(0, tab);
  const rest = tab === -1 ? "" : line.slice(tab + 1);
  if (status === "reloaded" || status === "pending") return { status, count: Number(rest) || 0 };
  if (status === "nochange") return { status };
  if (status === "unsupported" || status === "error") return { status, message: rest };
  return { status: "error", message: line };
}
