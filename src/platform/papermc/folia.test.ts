import { expect, test } from "vite-plus/test";
import { platforms } from "../index.ts";

test("folia platform exists", () => {
  expect(platforms.get("folia").id).toBe("folia");
  expect(platforms.get("Folia").id).toBe("folia");
  expect(() => platforms.get("@Folia")).toThrow("Platform with id '@Folia' not found");
});

test("folia platform versions", async () => {
  const folia = platforms.get("folia");
  const versions = await folia.versions();
  expect(Array.isArray(versions)).toBe(true);
  expect(versions).toEqual(expect.arrayContaining(["1.21.6", "1.21.5", "1.21.4"]));
  expect(versions.length).toBeGreaterThan(0);

  const latest = await folia.latest();
  expect(latest.version).toBe(versions[0]);
});

test("folia platform download latest version", async () => {
  const folia = platforms.get("folia");
  const latestVersion = await folia.latest();
  const result = await folia.download(latestVersion, true);

  expect(result?.version).toBe(latestVersion.version);
  expect(result?.build).toBe(latestVersion.build);
  expect(result?.output instanceof Uint8Array).toBe(true);
  expect(result?.output.length).toBeGreaterThan(0);
});
