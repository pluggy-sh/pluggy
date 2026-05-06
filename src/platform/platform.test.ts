/**
 * Tests for `assertSamePlatformFamily` — the validator the test command
 * runs before expanding `compatibility.platforms` into a matrix. Imports
 * `../platform/index.ts` for its side-effect registrations.
 */

import { describe, expect, test } from "vite-plus/test";

import { assertSamePlatformFamily } from "./index.ts";

describe("assertSamePlatformFamily", () => {
  test("paper + spigot share the bukkit family", () => {
    expect(assertSamePlatformFamily(["paper", "spigot"])).toBe("bukkit");
  });

  test("returns the family for a single platform", () => {
    expect(assertSamePlatformFamily(["velocity"])).toBe("velocity");
  });

  test("rejects mixing bukkit and velocity", () => {
    expect(() => assertSamePlatformFamily(["paper", "velocity"])).toThrow(/must share one family/);
  });

  test("rejects mixing velocity and bungee", () => {
    expect(() => assertSamePlatformFamily(["velocity", "waterfall"])).toThrow(
      /must share one family/,
    );
  });

  test("rejects an empty list", () => {
    expect(() => assertSamePlatformFamily([])).toThrow(/empty/);
  });

  test("propagates getPlatform's error for unknown ids", () => {
    expect(() => assertSamePlatformFamily(["paper", "bogus"])).toThrow(/'bogus' not found/);
  });
});
