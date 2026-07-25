/**
 * Live tests for the Foojay Disco client. We deliberately hit the real
 * upstream API per the project's "no mocking for upstream" convention.
 * Disco is the source of truth for what we install, so a regression in
 * the response shape should fail CI loudly.
 *
 * Each test exercises one well-known major + distribution that's published
 * for every host pluggy supports, so the suite stays green on macOS, Linux,
 * and Windows runners.
 */

import { describe, expect, test } from "vite-plus/test";

import { listAvailableReleases, resolveJdk, targetForHost } from "./disco.ts";

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
    // Major 7 is below Temurin's published range; Disco returns no matches.
    await expect(resolveJdk({ major: 7 })).rejects.toThrow(/temurin has no Java 7/);
  }, 15_000);

  // Disco answers a wildly out-of-range major with a 400 rather than an empty
  // result. That used to surface as E_DISCO_HTTP telling the user to check
  // their network connection, for what is a typo.
  test("an out-of-range major reports availability, not a connectivity problem", async () => {
    await expect(resolveJdk({ major: 99 })).rejects.toThrow(/temurin has no Java 99/);
    await expect(resolveJdk({ major: 99 })).rejects.toMatchObject({
      code: "E_DISCO_NO_MATCH",
      hint: expect.stringContaining("Available:"),
    });
  }, 20_000);
});

describe("listAvailableReleases (live)", () => {
  test("returns one entry per published major, newest first", async () => {
    const releases = await listAvailableReleases("temurin");

    expect(releases.length).toBeGreaterThan(0);
    expect(releases.map((r) => r.major)).toEqual(
      releases.map((r) => r.major).sort((a, b) => b - a),
    );
    expect(new Set(releases.map((r) => r.major)).size).toBe(releases.length);
    expect(releases.some((r) => r.major === 21)).toBe(true);
    for (const release of releases) expect(release.fullVersion).toMatch(/^\d+/);
  }, 20_000);

  // The allowlist is host-agnostic, so it happily named distributions that
  // publish nothing for the running machine. This is the query that filters.
  test("is filtered to the host", async () => {
    const linux = await listAvailableReleases("temurin", { os: "linux", arch: "x64" });
    const macArm = await listAvailableReleases("temurin", { os: "macos", arch: "aarch64" });

    expect(linux.length).toBeGreaterThan(0);
    expect(macArm.length).toBeGreaterThan(0);
    expect(linux.map((r) => r.major)).not.toEqual(macArm.map((r) => r.major));
  }, 20_000);
});
