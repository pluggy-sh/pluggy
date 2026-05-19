import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { download, resolveApiVersion, versions } from "./papermc.ts";

test("papermc versions", async () => {
  const result = await versions("paper");
  expect(result.length).toBeGreaterThan(0);
});

test("papermc download latest version", async () => {
  const versionsList = await versions("paper");
  expect(versionsList.length).toBeGreaterThan(0);
  const latestVersion = versionsList[0].version.id;
  const result = await download("paper", latestVersion);
  expect(result.version).toBe(latestVersion);
  expect(result.build).toBeGreaterThan(0);
  expect(result.output instanceof ArrayBuffer).toBe(true);
});

describe("resolveApiVersion", () => {
  const URL = "https://example.invalid/metadata.xml";
  const original = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = original;
  });

  test("picks the highest build-stamped entry", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          "<metadata><versions>" +
            "<version>1.21.11-R0.1-SNAPSHOT</version>" +
            "<version>26.1.2.build.6-stable</version>" +
            "<version>26.1.2.build.8-stable</version>" +
            "<version>26.1.2.build.7-stable</version>" +
            "</versions></metadata>",
          { status: 200 },
        ),
    ) as typeof fetch;
    await expect(resolveApiVersion(URL, "26.1.2")).resolves.toBe("26.1.2.build.8-stable");
  });

  test("falls back to <mc>-R0.1-SNAPSHOT when no build-stamped entry matches", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          "<metadata><versions><version>1.21.8-R0.1-SNAPSHOT</version></versions></metadata>",
          {
            status: 200,
          },
        ),
    ) as typeof fetch;
    await expect(resolveApiVersion(URL, "1.21.8")).resolves.toBe("1.21.8-R0.1-SNAPSHOT");
  });

  test("falls back to <mc>-R0.1-SNAPSHOT on non-2xx response", async () => {
    globalThis.fetch = vi.fn(async () => new Response("nope", { status: 503 })) as typeof fetch;
    await expect(resolveApiVersion(URL, "1.21.8")).resolves.toBe("1.21.8-R0.1-SNAPSHOT");
  });

  test("falls back to <mc>-R0.1-SNAPSHOT when fetch itself rejects (offline)", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    await expect(resolveApiVersion(URL, "1.21.8")).resolves.toBe("1.21.8-R0.1-SNAPSHOT");
  });
});
