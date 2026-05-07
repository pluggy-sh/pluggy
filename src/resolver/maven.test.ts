/** Contract tests for src/resolver/maven.ts. Network I/O is mocked. */

import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import { getCachePath } from "../project.ts";

import type { ResolveContext } from "./index.ts";
import { resolveMaven } from "./maven.ts";

function okBinary(bytes: Uint8Array): Response {
  return new Response(bytes, { status: 200 });
}

function errorResponse(status: number, statusText: string): Response {
  return new Response(null, { status, statusText });
}

const baseCtx: ResolveContext = {
  rootDir: "/tmp",
  includePrerelease: false,
  force: false,
  registries: [],
};

describe("resolveMaven", () => {
  let cacheRoot: string;
  let origHome: string | undefined;
  let origXdg: string | undefined;
  let origLocalAppData: string | undefined;

  beforeEach(async () => {
    cacheRoot = await mkdtemp(join(tmpdir(), "pluggy-maven-"));
    origHome = process.env.HOME;
    origXdg = process.env.XDG_CACHE_HOME;
    origLocalAppData = process.env.LOCALAPPDATA;
    process.env.HOME = cacheRoot;
    process.env.XDG_CACHE_HOME = cacheRoot;
    process.env.LOCALAPPDATA = cacheRoot;
  });

  afterEach(async () => {
    process.env.HOME = origHome;
    process.env.XDG_CACHE_HOME = origXdg;
    process.env.LOCALAPPDATA = origLocalAppData;
    vi.unstubAllGlobals();
    await rm(cacheRoot, { recursive: true, force: true });
  });

  test("fetches from the first registry that responds 200", async () => {
    const bytes = new Uint8Array([0xca, 0xfe, 0xba, 0xbe]);
    const fetchMock = vi.fn(async (url: string | URL): Promise<Response> => {
      const s = String(url);
      if (s.endsWith(".jar")) return okBinary(bytes);
      // No POM published → no transitives, which is fine.
      return errorResponse(404, "Not Found");
    });
    vi.stubGlobal("fetch", fetchMock);

    const ctx: ResolveContext = {
      ...baseCtx,
      registries: ["https://repo1.example.com", "https://repo2.example.com"],
    };

    const got = await resolveMaven("net.kyori", "adventure-api", "4.22.0", ctx);

    const jarCalls = fetchMock.mock.calls.filter(([u]) => String(u).endsWith(".jar"));
    expect(jarCalls).toHaveLength(1);
    expect(String(jarCalls[0][0])).toBe(
      "https://repo1.example.com/net/kyori/adventure-api/4.22.0/adventure-api-4.22.0.jar",
    );
    expect(got.source).toEqual({
      kind: "maven",
      groupId: "net.kyori",
      artifactId: "adventure-api",
      version: "4.22.0",
    });
    expect(got.jarPath).toBe(
      join(getCachePath(), "dependencies", "maven", "net.kyori", "adventure-api", "4.22.0.jar"),
    );
    const expectedHex = createHash("sha256").update(bytes).digest("hex");
    expect(got.integrity).toBe(`sha256-${expectedHex}`);
    const written = await readFile(got.jarPath);
    expect(new Uint8Array(written)).toEqual(bytes);
    expect(got.transitiveDeps).toEqual([]);
  });

  test("falls back to the second registry when the first 404s", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string | URL): Promise<Response> => {
      const s = String(url);
      calls.push(s);
      if (s.startsWith("https://repo1.example.com") && s.endsWith(".jar")) {
        return errorResponse(404, "Not Found");
      }
      if (s.endsWith(".jar")) return okBinary(bytes);
      // POM lookups 404 → empty transitives.
      return errorResponse(404, "Not Found");
    });
    vi.stubGlobal("fetch", fetchMock);

    const ctx: ResolveContext = {
      ...baseCtx,
      registries: ["https://repo1.example.com/", "https://repo2.example.com/"],
    };

    const got = await resolveMaven("com.foo", "bar", "1.0.0", ctx);

    const jarCalls = calls.filter((c) => c.endsWith(".jar"));
    expect(jarCalls).toHaveLength(2);
    expect(jarCalls[0]).toContain("repo1.example.com");
    expect(jarCalls[1]).toContain("repo2.example.com");
    const expectedHex = createHash("sha256").update(bytes).digest("hex");
    expect(got.integrity).toBe(`sha256-${expectedHex}`);
  });

  test("throws with the full list of registries tried when all fail", async () => {
    const fetchMock = vi.fn(async (): Promise<Response> => errorResponse(404, "Not Found"));
    vi.stubGlobal("fetch", fetchMock);

    const ctx: ResolveContext = {
      ...baseCtx,
      registries: ["https://a.example.com", "https://b.example.com"],
    };

    await expect(resolveMaven("com.foo", "bar", "1.0.0", ctx)).rejects.toThrow(
      /com\.foo:bar:1\.0\.0.*a\.example\.com.*404.*b\.example\.com.*404/s,
    );
  });

  test("throws when no registries are configured", async () => {
    const ctx: ResolveContext = { ...baseCtx, registries: [] };
    await expect(resolveMaven("com.foo", "bar", "1.0.0", ctx)).rejects.toThrow(
      /no registries.*com\.foo:bar:1\.0\.0/s,
    );
  });

  test("resolves a SNAPSHOT version via maven-metadata.xml and fetches the timestamped jar", async () => {
    const bytes = new Uint8Array([0x11, 0x22, 0x33]);
    const metadata = `<?xml version="1.0" encoding="UTF-8"?>
<metadata>
  <versioning>
    <snapshotVersions>
      <snapshotVersion>
        <classifier>sources</classifier>
        <extension>jar</extension>
        <value>1.21.8-R0.1-20250930.141227-5</value>
      </snapshotVersion>
      <snapshotVersion>
        <extension>jar</extension>
        <value>1.21.8-R0.1-20250930.141227-5</value>
      </snapshotVersion>
    </snapshotVersions>
  </versioning>
</metadata>`;

    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL): Promise<Response> => {
        const s = String(url);
        calls.push(s);
        if (s.endsWith("/maven-metadata.xml")) return new Response(metadata, { status: 200 });
        if (s.endsWith("folia-api-1.21.8-R0.1-20250930.141227-5.jar")) return okBinary(bytes);
        return errorResponse(404, "Not Found");
      }),
    );

    const ctx: ResolveContext = {
      ...baseCtx,
      registries: ["https://repo.papermc.io/repository/maven-public/"],
    };
    const got = await resolveMaven("dev.folia", "folia-api", "1.21.8-R0.1-SNAPSHOT", ctx);

    expect(calls[0]).toMatch(/maven-metadata\.xml$/);
    expect(calls[1]).toMatch(/folia-api-1\.21\.8-R0\.1-20250930\.141227-5\.jar$/);
    const expectedHex = createHash("sha256").update(bytes).digest("hex");
    expect(got.integrity).toBe(`sha256-${expectedHex}`);
  });

  test("rejects the resolve when the .sha1 sidecar disagrees with the downloaded jar", async () => {
    const bytes = new Uint8Array([0xab, 0xcd, 0xef]);
    const fetchMock = vi.fn(async (url: string | URL): Promise<Response> => {
      const s = String(url);
      if (s.endsWith(".jar.sha1")) {
        // Wrong hash on purpose — sha1 of "abcdef" bytes is not all-fs.
        return new Response("ffffffffffffffffffffffffffffffffffffffff", { status: 200 });
      }
      if (s.endsWith(".jar.sha512") || s.endsWith(".jar.sha256")) {
        return errorResponse(404, "Not Found");
      }
      if (s.endsWith(".jar")) return okBinary(bytes);
      return errorResponse(404, "Not Found");
    });
    vi.stubGlobal("fetch", fetchMock);

    const ctx: ResolveContext = {
      ...baseCtx,
      registries: ["https://repo.example.com"],
    };
    await expect(resolveMaven("com.foo", "bar", "1.0.0", ctx)).rejects.toThrow(
      /sha1 mismatch.*com\.foo:bar:1\.0\.0/s,
    );
  });

  test("accepts the resolve when the .sha512 sidecar matches", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const realSha512 = createHash("sha512").update(bytes).digest("hex");
    const fetchMock = vi.fn(async (url: string | URL): Promise<Response> => {
      const s = String(url);
      if (s.endsWith(".jar.sha512")) return new Response(realSha512, { status: 200 });
      if (s.endsWith(".jar")) return okBinary(bytes);
      return errorResponse(404, "Not Found");
    });
    vi.stubGlobal("fetch", fetchMock);

    const ctx: ResolveContext = {
      ...baseCtx,
      registries: ["https://repo.example.com"],
    };
    const got = await resolveMaven("com.foo", "bar", "1.0.0", ctx);
    expect(got.integrity).toBe(`sha256-${createHash("sha256").update(bytes).digest("hex")}`);
  });

  test("computes SHA-256 over the downloaded bytes", async () => {
    const bytes = new TextEncoder().encode("hello world");
    const fetchMock = vi.fn(async () => okBinary(bytes));
    vi.stubGlobal("fetch", fetchMock);

    const ctx: ResolveContext = {
      ...baseCtx,
      registries: ["https://repo.example.com"],
    };
    const got = await resolveMaven("g", "a", "1", ctx);
    // Known SHA-256 of the UTF-8 bytes of "hello world".
    expect(got.integrity).toBe(
      "sha256-b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
    );
  });
});
