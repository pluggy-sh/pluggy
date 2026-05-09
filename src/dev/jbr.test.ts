/**
 * Contract tests for the JBR provisioning module. Network-dependent
 * `ensureJbr` is intentionally left to manual playground validation;
 * downloading 200MB on every CI run would be hostile.
 */

import process from "node:process";

import { describe, expect, test } from "vite-plus/test";

import {
  jbrArchiveName,
  jbrCacheKey,
  jbrJavaPath,
  jbrTarget,
  JBR_BUILD,
  JBR_VERSION,
} from "./jbr.ts";

describe("jbrTarget", () => {
  test("returns os/arch derived from process.platform / process.arch", () => {
    const target = jbrTarget();
    expect(["osx", "linux", "windows"]).toContain(target.os);
    expect(["aarch64", "x64"]).toContain(target.arch);

    if (process.platform === "darwin") expect(target.os).toBe("osx");
    if (process.platform === "linux") expect(target.os).toBe("linux");
    if (process.platform === "win32") expect(target.os).toBe("windows");

    if (process.arch === "arm64") expect(target.arch).toBe("aarch64");
    if (process.arch === "x64") expect(target.arch).toBe("x64");
  });
});

describe("jbrArchiveName", () => {
  test("matches JetBrains' published filename convention", () => {
    expect(jbrArchiveName({ os: "osx", arch: "aarch64" })).toBe(
      `jbrsdk-${JBR_VERSION}-osx-aarch64-${JBR_BUILD}.tar.gz`,
    );
    expect(jbrArchiveName({ os: "linux", arch: "x64" })).toBe(
      `jbrsdk-${JBR_VERSION}-linux-x64-${JBR_BUILD}.tar.gz`,
    );
    expect(jbrArchiveName({ os: "windows", arch: "x64" })).toBe(
      `jbrsdk-${JBR_VERSION}-windows-x64-${JBR_BUILD}.tar.gz`,
    );
  });
});

describe("jbrCacheKey", () => {
  test("is stable per (version, os, arch, build) so cache hits don't redownload", () => {
    const a = jbrCacheKey({ os: "linux", arch: "x64" });
    const b = jbrCacheKey({ os: "linux", arch: "x64" });
    expect(a).toBe(b);
    expect(a).toContain(JBR_VERSION);
    expect(a).toContain("linux-x64");
    expect(a).toContain(JBR_BUILD);
  });
});

describe("jbrJavaPath", () => {
  test("resolves the Mac bundle layout on osx", () => {
    const p = jbrJavaPath("/cache/jbr/abc", { os: "osx", arch: "aarch64" });
    expect(p).toMatch(/[\\/]Contents[\\/]Home[\\/]bin[\\/]java$/);
  });

  test("resolves the flat layout on linux", () => {
    const p = jbrJavaPath("/cache/jbr/abc", { os: "linux", arch: "x64" });
    expect(p).toMatch(/[\\/]bin[\\/]java$/);
    expect(p).not.toContain("Contents");
  });

  test("appends .exe on windows", () => {
    const p = jbrJavaPath("/cache/jbr/abc", { os: "windows", arch: "x64" });
    expect(p).toMatch(/[\\/]bin[\\/]java\.exe$/);
  });
});
