import { describe, expect, test } from "vite-plus/test";

import {
  DEFAULT_MAVEN_REGISTRIES,
  dedupeRegistryUrls,
  effectiveRegistries,
  expandRegistryAlias,
  registryUrl,
} from "./registry.ts";

describe("expandRegistryAlias", () => {
  test("expands `github:owner/repo` to the GitHub Packages URL", () => {
    expect(expandRegistryAlias("github:my-org/my-repo")).toBe(
      "https://maven.pkg.github.com/my-org/my-repo",
    );
  });

  test("passes http(s) URLs through unchanged", () => {
    expect(expandRegistryAlias("https://repo1.maven.org/maven2/")).toBe(
      "https://repo1.maven.org/maven2/",
    );
    expect(expandRegistryAlias("http://example.com/maven")).toBe("http://example.com/maven");
  });

  test("returns unknown schemes verbatim", () => {
    expect(expandRegistryAlias("nexus:my-team/internal")).toBe("nexus:my-team/internal");
  });

  test("returns plain strings without a scheme verbatim", () => {
    expect(expandRegistryAlias("repo.example.com")).toBe("repo.example.com");
  });
});

describe("registryUrl", () => {
  test("expands aliases on object-form Registry entries", () => {
    expect(
      registryUrl({
        url: "github:org/private",
        credentials: { username: "ci", password: "x" },
      }),
    ).toBe("https://maven.pkg.github.com/org/private");
  });
});

describe("dedupeRegistryUrls", () => {
  test("collapses trailing-slash variants of the same URL", () => {
    expect(
      dedupeRegistryUrls(["https://repo1.maven.org/maven2", "https://repo1.maven.org/maven2/"]),
    ).toEqual(["https://repo1.maven.org/maven2"]);
  });

  test("preserves the first-seen form", () => {
    expect(
      dedupeRegistryUrls(["https://repo1.maven.org/maven2/", "https://repo1.maven.org/maven2"]),
    ).toEqual(["https://repo1.maven.org/maven2/"]);
  });
});

describe("effectiveRegistries", () => {
  test("appends Maven Central when not declared", () => {
    expect(effectiveRegistries(["https://repo.papermc.io/repository/maven-public/"])).toEqual([
      "https://repo.papermc.io/repository/maven-public/",
      ...DEFAULT_MAVEN_REGISTRIES,
    ]);
  });

  test("does not duplicate Maven Central when the user already declared it", () => {
    const out = effectiveRegistries(["https://repo1.maven.org/maven2/"]);
    expect(out).toEqual(["https://repo1.maven.org/maven2/"]);
  });

  test("expands `github:` aliases in declared entries", () => {
    const out = effectiveRegistries([
      { url: "github:org/private", credentials: { username: "u", password: "p" } },
    ]);
    expect(out).toEqual(["https://maven.pkg.github.com/org/private", ...DEFAULT_MAVEN_REGISTRIES]);
  });

  test("returns just the defaults when declared is undefined", () => {
    expect(effectiveRegistries(undefined)).toEqual([...DEFAULT_MAVEN_REGISTRIES]);
  });
});
