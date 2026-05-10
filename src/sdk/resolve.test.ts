/**
 * Tests for `selectJdkForProject`. Stubs `getJavaRange` so behavior is
 * deterministic offline; the real network probe is exercised by Spigot
 * platform tests upstream.
 */

import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import type { ResolvedProject } from "../project.ts";

vi.mock("../platform/spigot/buildtools.ts", () => ({
  getJavaRange: vi.fn(),
}));

import { getJavaRange } from "../platform/spigot/buildtools.ts";

import { selectJdkForProject, selectJdkForVersion } from "./resolve.ts";

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

describe("selectJdkForVersion", () => {
  afterEach(() => {
    vi.mocked(getJavaRange).mockReset();
  });

  test("uses the explicit MC version, not versions[0]", async () => {
    vi.mocked(getJavaRange).mockImplementation(async (v: string) =>
      v === "1.20.4" ? [17, 25] : v === "1.21.4" ? [21, 25] : undefined,
    );
    const p = project({ compatibility: { versions: ["1.21.4", "1.20.4"], platforms: ["paper"] } });

    const sel20 = await selectJdkForVersion(p, "1.20.4");
    expect(sel20.major).toBe(17);
    expect(sel20.source).toBe("spigot-manifest");

    const sel21 = await selectJdkForVersion(p, "1.21.4");
    expect(sel21.major).toBe(21);
    expect(sel21.source).toBe("spigot-manifest");
  });

  test("project pin still wins regardless of MC version", async () => {
    vi.mocked(getJavaRange).mockResolvedValue([17, 25]);
    const sel = await selectJdkForVersion(
      project({ jdk: { major: 25, distribution: "graalvm_community" } }),
      "1.20.4",
    );
    expect(sel).toEqual({ major: 25, distribution: "graalvm_community", source: "project-pin" });
  });

  test("rejects project.jdk.distribution outside the allowlist", async () => {
    vi.mocked(getJavaRange).mockResolvedValue([21, 25]);
    await expect(
      selectJdkForVersion(
        project({ jdk: { distribution: "../../../tmp/evil" } as never }),
        "1.21.4",
      ),
    ).rejects.toThrow(/unknown distribution/);
  });

  test("rejects non-allowlisted distribution names", async () => {
    vi.mocked(getJavaRange).mockResolvedValue([21, 25]);
    await expect(
      selectJdkForVersion(project({ jdk: { distribution: "oracle" } as never }), "1.21.4"),
    ).rejects.toThrow(/unknown distribution/);
  });

  test("rejects non-integer project.jdk.major", async () => {
    await expect(
      selectJdkForVersion(
        project({ jdk: { major: 21.5 as never, distribution: "temurin" } }),
        "1.21.4",
      ),
    ).rejects.toThrow(/integer/);
  });

  test("rejects out-of-range project.jdk.major", async () => {
    await expect(
      selectJdkForVersion(project({ jdk: { major: 300, distribution: "temurin" } }), "1.21.4"),
    ).rejects.toThrow(/between/);
  });
});
