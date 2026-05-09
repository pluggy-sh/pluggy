import { expect, test } from "vite-plus/test";
import { platforms } from "../index.ts";

test("travertine platform exists", () => {
  expect(platforms.get("travertine").id).toBe("travertine");
  expect(platforms.get("Travertine").id).toBe("travertine");
  expect(() => platforms.get("@Travertine")).toThrow("Platform with id '@Travertine' not found");
});

test("travertine platform versions", async () => {
  const travertine = platforms.get("travertine");
  const versions = await travertine.versions();
  expect(Array.isArray(versions)).toBe(true);
  expect(versions).toEqual(expect.arrayContaining(["1.16", "1.15", "1.14"]));
  expect(versions.length).toBeGreaterThan(0);

  const latest = await travertine.latest();
  expect(latest.version).toBe(versions[0]);
});

test("travertine platform download latest version", async () => {
  const travertine = platforms.get("travertine");
  const latestVersion = await travertine.latest();
  const result = await travertine.download(latestVersion, true);

  expect(result?.version).toBe(latestVersion.version);
  expect(result?.build).toBe(latestVersion.build);
  expect(result?.output instanceof Uint8Array).toBe(true);
  expect(result?.output.length).toBeGreaterThan(0);
});
