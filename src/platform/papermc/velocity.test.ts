import { expect, test } from "vite-plus/test";
import { getPlatform } from "../index.ts";

test("velocity platform exists", () => {
  expect(getPlatform("velocity").id).toBe("velocity");
  expect(getPlatform("Velocity").id).toBe("velocity");
  expect(() => getPlatform("@Velocity")).toThrow("Platform with id '@Velocity' not found");
});

test("velocity platform versions surface MC versions, not velocity-api versions", async () => {
  const velocity = getPlatform("velocity");
  const versions = await velocity.getVersions();
  expect(Array.isArray(versions)).toBe(true);
  expect(versions).toEqual(expect.arrayContaining(["1.21.8", "1.20.6", "1.20.4"]));
  expect(versions.every((v) => /^\d+\.\d+/.test(v))).toBe(true);
  expect(versions.some((v) => v.includes("SNAPSHOT"))).toBe(false);

  const latest = await velocity.getLatestVersion();
  expect(latest.version).toBe(versions[0]);
});

test("velocity api coordinate resolves to a velocity-api release, not the MC input", async () => {
  const velocity = getPlatform("velocity");
  const api = await velocity.api("1.21.8");
  expect(api.dependencies).toHaveLength(1);
  const [dep] = api.dependencies;
  expect(dep.groupId).toBe("com.velocitypowered");
  expect(dep.artifactId).toBe("velocity-api");
  expect(dep.version).not.toBe("1.21.8");
  expect(dep.version).toMatch(/^\d+\.\d+\.\d+/);
});

test("velocity platform download latest version", async () => {
  const velocity = getPlatform("velocity");
  const latestVersion = await velocity.getLatestVersion();
  const result = await velocity.download(latestVersion, true);

  expect(result?.version).toBe(latestVersion.version);
  expect(result?.build).toBe(latestVersion.build);
  expect(result?.output instanceof Uint8Array).toBe(true);
  expect(result?.output.length).toBeGreaterThan(0);
});
