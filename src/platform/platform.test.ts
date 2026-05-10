/**
 * Tests for `platforms.assertSameFamily`, the validator the test command
 * runs before expanding `compatibility.platforms` into a matrix. Imports
 * `../platform/index.ts` for its side-effect registrations.
 */

import { describe, expect, test } from "vite-plus/test";

import { platforms } from "./index.ts";

describe("platforms.assertSameFamily", () => {
  test("paper + spigot share the bukkit family", () => {
    expect(platforms.assertSameFamily(["paper", "spigot"])).toBe("bukkit");
  });

  test("returns the family for a single platform", () => {
    expect(platforms.assertSameFamily(["velocity"])).toBe("velocity");
  });

  test("rejects mixing bukkit and velocity", () => {
    expect(() => platforms.assertSameFamily(["paper", "velocity"])).toThrow(
      /must share one family/,
    );
  });

  test("rejects mixing velocity and bungee", () => {
    expect(() => platforms.assertSameFamily(["velocity", "waterfall"])).toThrow(
      /must share one family/,
    );
  });

  test("rejects an empty list", () => {
    expect(() => platforms.assertSameFamily([])).toThrow(/empty/);
  });

  test("propagates platforms.get's error for unknown ids", () => {
    expect(() => platforms.assertSameFamily(["paper", "bogus"])).toThrow(/'bogus' not found/);
  });
});
