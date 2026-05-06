/**
 * Unit tests for pure helpers in `src/test/runner.ts`. No I/O — every
 * behavior here is input-output only.
 */

import { delimiter } from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { buildLauncherArgs, filterToLauncherArgs, parseJUnitReports } from "./runner.ts";

describe("buildLauncherArgs", () => {
  test("emits jar, classpath, scan-class-path, reports-dir", () => {
    const args = buildLauncherArgs({
      consoleJar: "/cache/junit.jar",
      classpath: ["/stage/test", "/stage/main", "/cache/dep.jar"],
      testClassesDir: "/stage/test",
      reportsDir: "/stage/reports",
    });
    expect(args[0]).toBe("-jar");
    expect(args[1]).toBe("/cache/junit.jar");
    expect(args[2]).toBe("execute");
    expect(args).toContain("--disable-banner");
    expect(args).toContain("--details=none");
    expect(args).toContain(
      `--class-path=/stage/test${delimiter}/stage/main${delimiter}/cache/dep.jar`,
    );
    expect(args).toContain("--scan-class-path=/stage/test");
    expect(args).toContain("--reports-dir=/stage/reports");
  });

  test("--fail-fast only when requested", () => {
    const without = buildLauncherArgs({
      consoleJar: "/j",
      classpath: [],
      testClassesDir: "/t",
      reportsDir: "/r",
    });
    expect(without).not.toContain("--fail-fast");

    const withFF = buildLauncherArgs({
      consoleJar: "/j",
      classpath: [],
      testClassesDir: "/t",
      reportsDir: "/r",
      failFast: true,
    });
    expect(withFF).toContain("--fail-fast");
  });

  test("propagates filter → launcher args", () => {
    const args = buildLauncherArgs({
      consoleJar: "/j",
      classpath: [],
      testClassesDir: "/t",
      reportsDir: "/r",
      filter: "@tag:slow",
    });
    expect(args).toContain("--include-tag=slow");
  });

  test("tag filter keeps --scan-class-path (it's a filter, not a selector)", () => {
    const args = buildLauncherArgs({
      consoleJar: "/j",
      classpath: [],
      testClassesDir: "/t",
      reportsDir: "/r",
      filter: "@tag:slow",
    });
    expect(args).toContain("--scan-class-path=/t");
  });

  test("method selector drops --scan-class-path (JUnit rejects scan + select)", () => {
    const args = buildLauncherArgs({
      consoleJar: "/j",
      classpath: [],
      testClassesDir: "/t",
      reportsDir: "/r",
      filter: "com.example.FooTest#works",
    });
    expect(args).toContain("--select-method=com.example.FooTest#works");
    expect(args.some((a) => a.startsWith("--scan-class-path"))).toBe(false);
  });
});

describe("filterToLauncherArgs", () => {
  test("@tag:<name> → --include-tag", () => {
    expect(filterToLauncherArgs("@tag:slow")).toEqual(["--include-tag=slow"]);
  });

  test("Class#method → --select-method", () => {
    expect(filterToLauncherArgs("com.example.FooTest#addsPlayer")).toEqual([
      "--select-method=com.example.FooTest#addsPlayer",
    ]);
  });

  test("Class#method containing * falls back to classname regex", () => {
    // # + * is ambiguous; we treat it as a classname glob and let the user
    // split if they really want a per-method regex.
    const [arg] = filterToLauncherArgs("Foo#bar*");
    expect(arg.startsWith("--include-classname=")).toBe(true);
  });

  test("plain classname glob → regex with * → .*", () => {
    expect(filterToLauncherArgs("com.example.*Test")).toEqual([
      "--include-classname=^com\\.example\\..*Test$",
    ]);
  });

  test("classname with only literal chars is anchored and escaped", () => {
    expect(filterToLauncherArgs("com.example.FooTest")).toEqual([
      "--include-classname=^com\\.example\\.FooTest$",
    ]);
  });
});

describe("parseJUnitReports", () => {
  test("empty input → zero totals", () => {
    const r = parseJUnitReports([]);
    expect(r).toEqual({ total: 0, passed: 0, failed: 0, skipped: 0, cases: [] });
  });

  test("single passing case", () => {
    const xml = `<?xml version="1.0"?>
<testsuite name="FooTest" tests="1" failures="0">
  <testcase name="works" classname="com.example.FooTest" time="0.012" />
</testsuite>`;
    const r = parseJUnitReports([xml]);
    expect(r.total).toBe(1);
    expect(r.passed).toBe(1);
    expect(r.failed).toBe(0);
    expect(r.cases[0]).toEqual({
      suite: "com.example.FooTest",
      name: "works",
      durationMs: 12,
      status: "passed",
      message: undefined,
      stackTrace: undefined,
    });
  });

  test("failure case captures message and stack trace", () => {
    const xml = `<?xml version="1.0"?>
<testsuite name="BarTest">
  <testcase name="breaks" classname="com.example.BarTest" time="0.003">
    <failure message="expected: &quot;a&quot; but was: &quot;b&quot;" type="AssertionError">at com.example.BarTest.breaks(BarTest.java:42)</failure>
  </testcase>
</testsuite>`;
    const r = parseJUnitReports([xml]);
    expect(r.failed).toBe(1);
    expect(r.cases[0].status).toBe("failed");
    expect(r.cases[0].message).toBe('expected: "a" but was: "b"');
    expect(r.cases[0].stackTrace).toContain("at com.example.BarTest.breaks");
  });

  test("<error> counts as failure", () => {
    const xml = `<?xml version="1.0"?>
<testsuite>
  <testcase name="crashes" classname="com.example.CrashTest" time="0">
    <error message="boom" type="NullPointerException" />
  </testcase>
</testsuite>`;
    const r = parseJUnitReports([xml]);
    expect(r.failed).toBe(1);
    expect(r.cases[0].message).toBe("boom");
  });

  test("<skipped /> → skipped", () => {
    const xml = `<?xml version="1.0"?>
<testsuite>
  <testcase name="later" classname="com.example.X" time="0">
    <skipped />
  </testcase>
</testsuite>`;
    const r = parseJUnitReports([xml]);
    expect(r.skipped).toBe(1);
    expect(r.cases[0].status).toBe("skipped");
  });

  test("aggregates multiple docs + mixed statuses", () => {
    const a = `<testsuite>
  <testcase name="p" classname="A" time="0.001" />
  <testcase name="f" classname="A" time="0.002"><failure message="x">trace</failure></testcase>
</testsuite>`;
    const b = `<testsuite>
  <testcase name="s" classname="B" time="0"><skipped /></testcase>
</testsuite>`;
    const r = parseJUnitReports([a, b]);
    expect(r).toMatchObject({ total: 3, passed: 1, failed: 1, skipped: 1 });
    expect(r.cases.map((c) => c.suite)).toEqual(["A", "A", "B"]);
  });
});
