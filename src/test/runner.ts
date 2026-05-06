/**
 * Pure helpers for the test runner: JUnit Console Launcher argument
 * assembly, `--filter` translation, and JUnit-XML report parsing. No I/O —
 * callers in `./index.ts` spawn the JVM and read the reports directory.
 */

import { delimiter } from "node:path";

export interface LauncherArgs {
  /** Absolute path to junit-platform-console-standalone jar. */
  consoleJar: string;
  /** Every entry that should be on the JVM classpath. */
  classpath: string[];
  /** Directory whose compiled classes are scanned for tests. */
  testClassesDir: string;
  /** Where JUnit should write XML reports. */
  reportsDir: string;
  /** User filter (see `parseFilter`). */
  filter?: string;
  /** Stop on first failure. */
  failFast?: boolean;
  /**
   * JVM system properties to pass before `-jar` (rendered as `-Dkey=value`).
   * Ordered iteration; values are not escaped — callers must pre-validate.
   */
  systemProperties?: Record<string, string>;
}

export interface TestCase {
  /** Fully-qualified class name (e.g. `com.example.FooTest`). */
  suite: string;
  /** Method name (e.g. `addsPlayer`). */
  name: string;
  durationMs: number;
  status: "passed" | "failed" | "skipped";
  message?: string;
  stackTrace?: string;
}

export interface TestRunResult {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  cases: TestCase[];
}

/**
 * Assemble the argv for `java -jar junit-platform-console-standalone …`.
 * Caller prepends `java` and spawns.
 */
export function buildLauncherArgs(args: LauncherArgs): string[] {
  const filterArgs = args.filter === undefined ? [] : filterToLauncherArgs(args.filter);
  // ConsoleLauncher refuses `--scan-class-path` combined with any `--select-*`
  // argument ("Scanning the classpath and using explicit selectors at the same
  // time is not supported"). Drop the scan directive when a selector is present —
  // the selector does its own discovery against `--class-path`.
  const hasSelector = filterArgs.some((a) => a.startsWith("--select-"));

  const out: string[] = [];
  if (args.systemProperties !== undefined) {
    for (const [key, value] of Object.entries(args.systemProperties)) {
      out.push(`-D${key}=${value}`);
    }
  }
  out.push(
    "-jar",
    args.consoleJar,
    // `execute` is the explicit subcommand; newer standalone jars warn without it.
    "execute",
    "--disable-banner",
    "--details=none",
    `--class-path=${args.classpath.join(delimiter)}`,
  );
  if (!hasSelector) {
    out.push(`--scan-class-path=${args.testClassesDir}`);
  }
  out.push(`--reports-dir=${args.reportsDir}`);
  if (args.failFast === true) {
    out.push("--fail-fast");
  }
  out.push(...filterArgs);
  return out;
}

/**
 * Translate pluggy's user-facing `--filter <pattern>` into JUnit Console
 * Launcher arguments.
 *
 *   @tag:<name>     → --include-tag=<name>
 *   Class#method    → --select-method=Class#method
 *   <classname>     → --include-classname=<regex>  (glob * → .*, other chars escaped)
 */
export function filterToLauncherArgs(filter: string): string[] {
  if (filter.startsWith("@tag:")) {
    const tag = filter.slice("@tag:".length);
    return [`--include-tag=${tag}`];
  }
  if (filter.includes("#") && !filter.includes("*")) {
    return [`--select-method=${filter}`];
  }
  return [`--include-classname=${globToRegex(filter)}`];
}

/**
 * Parse every `TEST-*.xml` file's content into a flat `TestRunResult`.
 * Input is the array of XML document strings — the caller reads the
 * directory. Empty input produces a zero-total result.
 */
export function parseJUnitReports(xmlDocs: string[]): TestRunResult {
  const cases: TestCase[] = [];
  for (const xml of xmlDocs) {
    for (const entry of parseSuite(xml)) {
      cases.push(entry);
    }
  }
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const c of cases) {
    if (c.status === "passed") passed += 1;
    else if (c.status === "failed") failed += 1;
    else skipped += 1;
  }
  return { total: cases.length, passed, failed, skipped, cases };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function parseSuite(xml: string): TestCase[] {
  const cases: TestCase[] = [];
  const caseBlocks = xml.match(/<testcase\b[\s\S]*?(?:\/>|<\/testcase>)/g);
  if (caseBlocks === null) return cases;

  for (const block of caseBlocks) {
    const suite = readAttr(block, "classname") ?? "";
    const name = readAttr(block, "name") ?? "";
    const timeRaw = readAttr(block, "time");
    const durationMs = timeRaw !== undefined ? Math.round(Number.parseFloat(timeRaw) * 1000) : 0;

    let status: TestCase["status"] = "passed";
    let message: string | undefined;
    let stackTrace: string | undefined;

    const failure = extractChild(block, "failure") ?? extractChild(block, "error");
    if (failure !== undefined) {
      status = "failed";
      message = decodeEntities(failure.attrs.message ?? "");
      stackTrace = failure.body.trim().length > 0 ? decodeEntities(failure.body).trim() : undefined;
    } else if (extractChild(block, "skipped") !== undefined) {
      status = "skipped";
    }

    cases.push({ suite, name, durationMs, status, message, stackTrace });
  }
  return cases;
}

function readAttr(tag: string, attr: string): string | undefined {
  const m = tag.match(new RegExp(`\\b${attr}="([^"]*)"`));
  return m === null ? undefined : m[1];
}

function extractChild(
  block: string,
  tagName: string,
): { attrs: Record<string, string>; body: string } | undefined {
  // Matches either <tag ... /> or <tag ...>body</tag>.
  const selfClose = new RegExp(`<${tagName}\\b([^>]*)\\/>`);
  const paired = new RegExp(`<${tagName}\\b([^>]*)>([\\s\\S]*?)<\\/${tagName}>`);
  const paired_m = block.match(paired);
  if (paired_m !== null) {
    return { attrs: parseAttrs(paired_m[1]), body: paired_m[2] };
  }
  const self_m = block.match(selfClose);
  if (self_m !== null) {
    return { attrs: parseAttrs(self_m[1]), body: "" };
  }
  return undefined;
}

function parseAttrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  const rx = /(\w+)="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(raw)) !== null) {
    out[m[1]] = m[2];
  }
  return out;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#10;/g, "\n")
    .replace(/&#13;/g, "\r")
    .replace(/&#9;/g, "\t")
    .replace(/&amp;/g, "&");
}

function globToRegex(pattern: string): string {
  let out = "";
  for (const ch of pattern) {
    if (ch === "*") {
      out += ".*";
    } else if (/[.+?^${}()|[\]\\]/.test(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  return `^${out}$`;
}
