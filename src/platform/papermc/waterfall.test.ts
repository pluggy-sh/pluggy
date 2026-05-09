import { expect, test } from "vite-plus/test";
import { platforms } from "../index.ts";

test("waterfall platform exists", () => {
  expect(platforms.get("waterfall").id).toBe("waterfall");
  expect(platforms.get("Waterfall").id).toBe("waterfall");
  expect(() => platforms.get("@Waterfall")).toThrow("Platform with id '@Waterfall' not found");
});

test("waterfall platform versions", async () => {
  const waterfall = platforms.get("waterfall");
  const versions = await waterfall.versions();
  expect(Array.isArray(versions)).toBe(true);
  expect(versions).toEqual(expect.arrayContaining(["1.21", "1.20", "1.19", "1.18"]));
  expect(versions.length).toBeGreaterThan(0);

  const latest = await waterfall.latest();
  expect(latest.version).toBe(versions[0]);
});

test("waterfall platform download latest version", async () => {
  const waterfall = platforms.get("waterfall");
  const latestVersion = await waterfall.latest();
  const result = await waterfall.download(latestVersion, true);

  expect(result?.version).toBe(latestVersion.version);
  expect(result?.build).toBe(latestVersion.build);
  expect(result?.output instanceof Uint8Array).toBe(true);
  expect(result?.output.length).toBeGreaterThan(0);
});
