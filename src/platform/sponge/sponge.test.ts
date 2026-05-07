import process from "node:process";

import { expect, test } from "vite-plus/test";

import { getPlatform } from "../index.ts";

// sponge.download streams the SpongeVanilla universal jar (~30 MB+) over the
// network. Gated behind PLUGGY_INTEGRATION=1 to keep CI fast.
const integration = process.env.PLUGGY_INTEGRATION === "1";

test("sponge platform exists", () => {
  expect(getPlatform("sponge").id).toBe("sponge");
  expect(getPlatform("Sponge").id).toBe("sponge");
  expect(() => getPlatform("@Sponge")).toThrow("Platform with id '@Sponge' not found");
});

test("sponge platform versions surface stable MC versions", async () => {
  const sponge = getPlatform("sponge");
  const versions = await sponge.getVersions();
  expect(Array.isArray(versions)).toBe(true);
  expect(versions.length).toBeGreaterThan(0);
  expect(versions.every((v) => /^\d+(\.\d+)+/.test(v))).toBe(true);
  expect(versions.some((v) => v.includes("snapshot"))).toBe(false);
  expect(versions.some((v) => v.includes("pre"))).toBe(false);
});

test("sponge api coordinate resolves to a SpongeAPI release, not the MC input", async () => {
  const sponge = getPlatform("sponge");
  const latest = await sponge.getLatestVersion();
  const api = await sponge.api(latest.version);

  expect(api.repositories).toEqual(
    expect.arrayContaining(["https://repo.spongepowered.org/repository/maven-public/"]),
  );
  expect(api.dependencies).toHaveLength(1);
  const [dep] = api.dependencies;
  expect(dep.groupId).toBe("org.spongepowered");
  expect(dep.artifactId).toBe("spongeapi");
  expect(dep.version).not.toBe(latest.version);
  expect(dep.version).toMatch(/^\d+\.\d+\.\d+/);
});

test.runIf(integration)("sponge platform download latest version", async () => {
  const sponge = getPlatform("sponge");
  const latestVersion = await sponge.getLatestVersion();
  const result = await sponge.download(latestVersion, true);

  expect(result?.version).toBe(latestVersion.version);
  expect(result?.build).toBe(latestVersion.build);
  expect(result?.output instanceof Uint8Array).toBe(true);
  expect(result?.output.length).toBeGreaterThan(0);
});
