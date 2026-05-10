import { describe, expect, test } from "vite-plus/test";
import {
  type InstallMethod,
  describeInstallMethod,
  detectInstallMethod,
  upgradeCommandFor,
} from "./install-method.ts";

describe("detectInstallMethod", () => {
  const cases: Array<{ path: string; expected: InstallMethod }> = [
    // Homebrew layouts across prefixes.
    { path: "/opt/homebrew/Cellar/pluggy/0.4.0/bin/pluggy", expected: "homebrew" },
    { path: "/usr/local/Cellar/pluggy/0.4.0/bin/pluggy", expected: "homebrew" },
    {
      path: "/home/linuxbrew/.linuxbrew/Cellar/pluggy/0.4.0/bin/pluggy",
      expected: "homebrew",
    },

    // Scoop layout.
    {
      path: "C:\\Users\\christian\\scoop\\apps\\pluggy\\current\\pluggy.exe",
      expected: "scoop",
    },
    {
      path: "C:\\Users\\christian\\scoop\\apps\\pluggy\\0.4.0\\pluggy.exe",
      expected: "scoop",
    },

    // Install script defaults.
    { path: "/Users/christian/.pluggy/bin/pluggy", expected: "manual" },
    { path: "/home/x/.pluggy/bin/pluggy", expected: "manual" },
    {
      path: "C:\\Users\\christian\\AppData\\Local\\Programs\\pluggy\\pluggy.exe",
      expected: "manual",
    },

    // Unrecognised: anything else (e.g. dropped into /tmp by hand).
    { path: "/tmp/pluggy", expected: "unknown" },
    { path: "/some/random/place/pluggy", expected: "unknown" },
  ];

  for (const { path, expected } of cases) {
    test(`classifies ${path} as ${expected}`, () => {
      const info = detectInstallMethod(path);
      expect(info.method).toBe(expected);
      expect(info.rawPath).toBe(path);
    });
  }
});

describe("describeInstallMethod", () => {
  test("returns human-friendly labels", () => {
    expect(describeInstallMethod("homebrew")).toBe("Homebrew");
    expect(describeInstallMethod("scoop")).toBe("Scoop");
    expect(describeInstallMethod("manual")).toBe("install script");
    expect(describeInstallMethod("unknown")).toBe("unknown");
  });
});

describe("upgradeCommandFor", () => {
  test("returns the package-manager command for managed installs", () => {
    expect(upgradeCommandFor("homebrew")).toBe("brew upgrade pluggy");
    expect(upgradeCommandFor("scoop")).toBe("scoop update pluggy");
  });

  test("returns undefined for self-updateable installs", () => {
    expect(upgradeCommandFor("manual")).toBeUndefined();
    expect(upgradeCommandFor("unknown")).toBeUndefined();
  });
});
