/**
 * Live tests for the Foojay Disco client. We deliberately hit the real
 * upstream API per the project's "no mocking for upstream" convention —
 * Disco is the source of truth for what we install, so a regression in
 * the response shape should fail CI loudly.
 *
 * Each test exercises one well-known major + distribution that's published
 * for every host pluggy supports, so the suite stays green on macOS, Linux,
 * and Windows runners.
 */

import { describe, expect, test } from "vite-plus/test";

import { resolveJdk, targetForHost } from "./disco.ts";

describe("targetForHost", () => {
  test("returns a non-empty os and arch for the running host", () => {
    const t = targetForHost();
    expect(t.os).toMatch(/^(macos|linux|windows)$/);
    expect(t.arch).toMatch(/^(aarch64|x64)$/);
  });
});

describe("resolveJdk (live)", () => {
  test("resolves Temurin 21 for the running host", async () => {
    const spec = await resolveJdk({ major: 21 });
    expect(spec.distribution).toBe("temurin");
    expect(spec.major).toBe(21);
    expect(spec.fullVersion).toMatch(/^21(\.\d+){1,3}/);
    expect(spec.downloadUrl.startsWith("https://")).toBe(true);
    expect(spec.archiveType).toMatch(/^(tar\.gz|zip)$/);
    expect(spec.filename.length).toBeGreaterThan(0);
  }, 15_000);

  test("propagates a clean error for a non-existent distribution+major combo", async () => {
    // Major 7 is below Temurin's published range — Disco returns no matches.
    await expect(resolveJdk({ major: 7 })).rejects.toThrow(/no temurin JDK 7/);
  }, 15_000);
});
