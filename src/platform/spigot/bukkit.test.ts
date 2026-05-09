import process from "node:process";

import { expect, test } from "vite-plus/test";

import { platforms } from "../index.ts";

// bukkit.download runs BuildTools: slow and Java-dependent. Gated behind PLUGGY_INTEGRATION=1.
const integration = process.env.PLUGGY_INTEGRATION === "1";

test("bukkit platform exists", () => {
  expect(platforms.get("bukkit").id).toBe("bukkit");
  expect(platforms.get("Bukkit").id).toBe("bukkit");
  expect(() => platforms.get("@Bukkit")).toThrow("Platform with id '@Bukkit' not found");
});

test("bukkit platform versions", async () => {
  const bukkit = platforms.get("bukkit");
  const versions = await bukkit.versions();
  expect(Array.isArray(versions)).toBe(true);
  expect(versions).toEqual(expect.arrayContaining(["1.20.5", "1.20.4", "1.20.3"]));
  expect(versions.length).toBeGreaterThan(0);

  const latest = await bukkit.latest();
  expect(latest.version).toBe(versions[0]);
});

test.runIf(integration)("bukkit platform download latest version", async () => {
  const bukkit = platforms.get("bukkit");
  const latestVersion = await bukkit.latest();
  const result = await bukkit.download(latestVersion, true);

  expect(result?.version).toBe(latestVersion.version);
  expect(result?.build).toBe(latestVersion.build);
  expect(result?.output instanceof Uint8Array).toBe(true);
  expect(result?.output.length).toBeGreaterThan(0);
});
