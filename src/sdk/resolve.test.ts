/**
 * Tests for `selectJdkForProject`. Stubs `getJavaRange` so behavior is
 * deterministic offline — the real network probe is exercised by Spigot
 * platform tests upstream.
 */

import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import type { ResolvedProject } from "../project.ts";

vi.mock("../platform/spigot/buildtools.ts", () => ({
  getJavaRange: vi.fn(),
}));

import { getJavaRange } from "../platform/spigot/buildtools.ts";

import { selectJdkForProject } from "./resolve.ts";

function project(overrides: Partial<ResolvedProject> = {}): ResolvedProject {
  return {
    name: "p",
    version: "1.0.0",
    main: "com.example.Main",
    compatibility: { versions: ["1.21.4"], platforms: ["paper"] },
    rootDir: "/tmp/p",
    projectFile: "/tmp/p/project.json",
    ...overrides,
  };
}

describe("selectJdkForProject", () => {
  afterEach(() => {
    vi.mocked(getJavaRange).mockReset();
  });

  test("explicit project pin wins over Spigot manifest", async () => {
    vi.mocked(getJavaRange).mockResolvedValue([21, 25]);
    const sel = await selectJdkForProject(project({ jdk: { major: 17, distribution: "zulu" } }));
    expect(sel).toEqual({ major: 17, distribution: "zulu", source: "project-pin" });
  });

  test("Spigot manifest range → minimum of range", async () => {
    vi.mocked(getJavaRange).mockResolvedValue([21, 25]);
    const sel = await selectJdkForProject(project());
    expect(sel.major).toBe(21);
    expect(sel.distribution).toBe("temurin");
    expect(sel.source).toBe("spigot-manifest");
  });

  test("falls through to heuristic when Spigot manifest is unavailable", async () => {
    vi.mocked(getJavaRange).mockResolvedValue(undefined);
    const sel = await selectJdkForProject(
      project({ compatibility: { versions: ["1.18.2"], platforms: ["paper"] } }),
    );
    expect(sel.major).toBe(17);
    expect(sel.source).toBe("fallback-table");
  });

  test("falls through to default-21 when prefix doesn't match", async () => {
    vi.mocked(getJavaRange).mockResolvedValue(undefined);
    const sel = await selectJdkForProject(
      project({ compatibility: { versions: ["999.0"], platforms: ["paper"] } }),
    );
    expect(sel.major).toBe(21);
    expect(sel.source).toBe("fallback-default");
  });

  test("missing compatibility.versions defaults to 21", async () => {
    const sel = await selectJdkForProject(
      project({ compatibility: { versions: [], platforms: ["paper"] } }),
    );
    expect(sel.major).toBe(21);
    expect(sel.source).toBe("fallback-default");
  });
});
