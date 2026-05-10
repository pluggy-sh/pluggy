# `pluggy test`

Compile the project's main and test sources, run them through the JUnit Platform Console Launcher, and parse the resulting JUnit XML reports into a flat per-test result. JUnit is the standard testing framework for Java; pluggy bundles its launcher so you don't install it yourself.

## Usage

```text
pluggy test [options]
pluggy t    [options]
```

## Flags

| Flag                 | Default | Notes                                                                         |
| -------------------- | ------- | ----------------------------------------------------------------------------- |
| `--filter <pattern>` | none    | Restrict which tests run. See [Filter syntax](#filter-syntax) below.          |
| `--fail-fast`        | off     | Stop after the first test failure (passed through to the JUnit launcher).     |
| `--clean`            | off     | Wipe the test staging dir before running (compiled classes + cached reports). |
| `--workspace <name>` | none    | Test only this workspace.                                                     |
| `--workspaces`       | off     | Explicit all-workspaces test from the root.                                   |

## Scope rules

| Location                       | Flags                   | Tests                                   |
| ------------------------------ | ----------------------- | --------------------------------------- |
| Standalone project             | none                    | The project.                            |
| Inside workspace `X`           | none                    | `X`.                                    |
| Repo root, workspaces declared | none                    | Every workspace, topologically ordered. |
| Repo root, workspaces declared | `--workspace A`         | Just `A`.                               |
| Inside workspace `X`           | `--workspaces`          | **Error**. Only valid at the root.      |
| Inside workspace `X`           | `--workspace Y` (Y ≠ X) | **Error**. Run from the root.           |

A workspace with no `test/` directory or no `.java` sources under it is skipped, not failed. That keeps `--workspaces` runs ergonomic when only some workspaces have tests.

## Layout

```text
<workspace>/
├── src/                    main sources (compiled and packaged into main.jar)
├── test/                   JUnit sources (must contain at least one .java file)
└── .pluggy-build/<hash>-test/
    ├── main-jar-stage/     staged classes + descriptor + resources
    ├── main.jar            full plugin jar (handed off via system property)
    ├── main-runtime.jar    same minus the entry-point class (runtime classpath)
    ├── test-classes/       compiled test sources
    └── reports/            TEST-*.xml emitted by the JUnit launcher
```

`<hash>` is the same 12-hex digest used by `pluggy build`
(`sha256(name \0 version \0 rootDir)`). `--clean` wipes the entire
`<hash>-test` directory; the per-run `reports/` folder is always wiped
to keep stale XML from a deleted test class out of the result.

### Why two main jars?

`main.jar` is the production-shaped artifact: classes, generated descriptor, every `resources` entry. It's what mocking frameworks (MockBukkit and anything else that mounts a plugin classloader) load from disk via the `pluggy.test.mainJar` system property. See [Mocking-framework hand-off](#mocking-framework-hand-off) below.

`main-runtime.jar` is the same jar with the declared entry-point class (`project.main`) stripped out. It goes on the system test classpath so plain utility classes (services, parsers, listeners) are reachable for non-mocking unit tests. The entry-point stays _off_ the system loader so the mocking framework's own `ConfiguredPluginClassLoader` can own it cleanly. Without that, Bukkit's `JavaPlugin requires a valid classloader` check fires the moment a mocking framework tries to load the plugin.

Normal tests don't see the split. It only matters when something at runtime references the entry-point class directly. See the [Caveats](#caveats) below.

## Pipeline

For each target workspace, pluggy runs the steps below in order.

1. **Detect tests.** No `test/` directory means `no-test-dir`. Directory exists but no `.java` under it means `no-sources`. Either case skips the workspace with status `ok`.
2. **Resolve main deps.** `project.dependencies`, plus the primary platform's `api()` Maven coordinate, against the project's `registries`.
3. **Resolve test deps.** `project.testDependencies` against `registries` plus Maven Central. JUnit Platform Console Standalone (`org.junit.platform:junit-platform-console-standalone:1.11.4`) is always added to the test classpath. You never declare it.
4. **Compile main.** `javac` over `src/` into `main-jar-stage/`, with classpath = main deps + platform API.
5. **Package `main.jar` and `main-runtime.jar`.** Stage `resources` and the generated descriptor (the same logic `pluggy build` runs), zip into `main.jar`, then zip again into `main-runtime.jar` excluding the entry-point `.class`.
6. **Compile tests.** `javac` over `test/` against `main.jar` (so test code can import everything), plus main deps, test deps, and the JUnit standalone jar.
7. **Run.** `java -Dpluggy.test.mainJar=<.../main.jar> -jar junit-platform-console-standalone.jar execute ...`. The runtime classpath is `main-runtime.jar` plus main deps, test deps, and JUnit. `--filter` translates to `--include-tag`, `--select-method`, or `--include-classname`. `--fail-fast` translates to `--fail-fast`.
8. **Parse.** Read every `TEST-*.xml` from `reports/` and flatten into a single `{ total, passed, failed, skipped, cases[] }` shape. The launcher's own stdout and stderr are discarded; pluggy renders its own output from the XML.

`testDependencies` follows the same grammar as `dependencies`. See [`project.json` reference](../project-json.md#testdependencies).

## Mocking-framework hand-off

Tests are launched with a small set of system properties that point at the resolved jars on disk. The contract is framework-agnostic. Any test runner, any future mocking library, can read these properties.

| Property                        | Value                                                                                                                                                           |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pluggy.test.mainJar`           | Absolute path to the plugin's own jar (`main.jar`).                                                                                                             |
| `pluggy.test.dependency.<name>` | One per declared dep, keyed by the name in `project.json` (`dependencies` and `testDependencies`). Value is the absolute path to that dep's resolved jar.       |
| `pluggy.test.dependencies`      | Every declared dep jar, joined by `File.pathSeparator` (`:` on POSIX, `;` on Windows). Order: `dependencies` first, then `testDependencies`, declaration order. |

Transitive deps don't get their own property. They're already on the runtime classpath, and surfacing them would let tests bind to indirect dep names that change without notice. Library-style Maven deps (for example `commons-lang3`) appear in the catalog alongside plugin-shaped deps. pluggy doesn't try to detect "is this a plugin?". If a test calls `MockBukkit.loadJar` on a library jar, the framework's own error ("no plugin.yml") tells the user to skip that one.

If a name appears in both `dependencies` and `testDependencies`, the `testDependencies` entry wins.

### Pick one dep by name

```java
@Test
void warnsWhenWorldEditMissing() {
    // No extra plugins loaded — your plugin should detect the absence
    // and fall back gracefully.
    plugin = MockBukkit.loadJar(new File(System.getProperty("pluggy.test.mainJar")));
    server.getPluginManager().enablePlugin(plugin);
    // assert your plugin logged "WorldEdit not found, disabling integration"
}

@Test
void integratesWithWorldEditWhenPresent() {
    File worldEdit = new File(System.getProperty("pluggy.test.dependency.worldedit"));
    MockBukkit.loadJar(worldEdit);
    plugin = MockBukkit.loadJar(new File(System.getProperty("pluggy.test.mainJar")));
    server.getPluginManager().enablePlugin(plugin);
    // assert your plugin registered a WorldEdit hook
}
```

A small helper makes this readable in test base classes:

```java
private static File dep(String name) {
    return new File(System.getProperty("pluggy.test.dependency." + name));
}
```

### Boot every declared dep

```java
@Test
void cooperatesWithEverything() {
    String all = System.getProperty("pluggy.test.dependencies");
    for (String path : all.split(File.pathSeparator)) {
        if (path.isEmpty()) continue;
        try {
            MockBukkit.loadJar(new File(path));
        } catch (Exception ignored) {
            // Library jars without a plugin.yml fail here; skip them.
        }
    }
    plugin = MockBukkit.loadJar(new File(System.getProperty("pluggy.test.mainJar")));
    server.getPluginManager().enablePlugin(plugin);
}
```

Loading a real third-party plugin (WorldEdit, LuckPerms, ...) into MockBukkit can fail with `JavaPlugin requires a valid classloader` when that plugin's entry class is already on the runtime classpath. The catalog only promises the path. Whether the jar loads cleanly under a given framework is between the plugin and the framework. For "is plugin X around?" coverage that doesn't need the third-party plugin to actually boot, register a stub via `registerLoadedPlugin` with the dep's name.

See the [testing-with-mockbukkit](../recipes/testing-with-mockbukkit.md) recipe for a worked example.

## Caveats

The entry-point class declared in `project.main` is _not_ on the runtime test classpath. Test code can `import com.example.demo.Main` freely (the compile classpath has the full `main.jar`), but at runtime any expression that requires the class to be loadable by the system classloader (`Main.class`, `new Main()`, `Class.forName("...Main")` through the test classloader) throws `NoClassDefFoundError`. Use the `pluggy.test.mainJar` hand-off and the framework's own loader (returning `Plugin` or `JavaPlugin`) instead.

Every other plugin class is on the runtime classpath as normal.

## Filter syntax

`--filter` accepts three forms, picked in this order:

| Pattern        | Routed to                      | Matches                             |
| -------------- | ------------------------------ | ----------------------------------- |
| `@tag:<name>`  | `--include-tag=<name>`         | JUnit `@Tag("<name>")` annotations. |
| `Class#method` | `--select-method=Class#method` | One specific test method.           |
| `<glob>`       | `--include-classname=<regex>`  | Class names matching the glob.      |

Globs use `*` (one segment of any length) and are anchored. `*FooTest` matches `com.example.FooTest`, `Foo*` matches `FooBarTest`. Other regex metacharacters are escaped before passing to JUnit.

`Class#method` only triggers when the pattern contains `#` and no `*`. Otherwise it falls through to the classname glob.

## Output

JUnit Jupiter test names are the method name plus `()` by default. That's what shows up in both human and JSON output. Use `@DisplayName("...")` on a method to override.

Human, single workspace, all green:

```text
test demo
  com.example.demo.GreeterTest
    ✓ countsWordsCorrectly()  8ms
    ✓ rejectsEmptyName()  0ms
    ✓ greetsNamedUser()  0ms

  3 passed
```

Human, with a failure:

```text
test demo
  com.example.demo.GreeterTest
    ✓ countsWordsCorrectly()  0ms
    ✓ rejectsEmptyName()  0ms
    ✓ greetsNamedUser()  0ms
  com.example.demo.FailingTest
    ✗ deliberatelyFails()  10ms
        expected: <2> but was: <1>
        at org.junit.jupiter.api.AssertionFailureBuilder.build(AssertionFailureBuilder.java:151)

  3 passed, 1 failed
```

The "at ..." line is the _first_ stack frame in the report, which for a JUnit Jupiter `assertEquals` failure is JUnit's internal builder. Inspect the full `failures[].stackTrace` in JSON output (or the JUnit XML in `.pluggy-build/<hash>-test/reports/`) to see the user-code frame.

Human, multi-workspace, summary appended:

```text
test api
  …
test impl
  …

summary
  api: 12 passed (480ms)
  impl: 3 passed, 1 failed (610ms)
```

`no test/ directory` and `no .java sources in test/` show in the summary
in place of counts.

## JSON output

Top-level shape:

```json
{
  "status": "success",
  "results": [
    {
      "workspace": "demo",
      "rootDir": "/Users/you/demo",
      "ok": true,
      "durationMs": 6210,
      "tests": { "total": 3, "passed": 3, "failed": 0, "skipped": 0 }
    }
  ]
}
```

Per-result fields:

| Field      | When present                        | Meaning                                                        |
| ---------- | ----------------------------------- | -------------------------------------------------------------- |
| `tests`    | Tests actually ran.                 | `{ total, passed, failed, skipped }`.                          |
| `failures` | At least one failure.               | Array of `{ class, test, durationMs, message?, stackTrace? }`. |
| `skipped`  | Workspace produced no tests.        | `"no-test-dir"` or `"no-sources"`.                             |
| `error`    | Workspace errored before tests ran. | The error message (for example a compile failure).             |

On a failed run:

```json
{
  "status": "error",
  "results": [
    {
      "workspace": "demo",
      "rootDir": "/Users/you/demo",
      "ok": false,
      "durationMs": 7175,
      "tests": { "total": 4, "passed": 3, "failed": 1, "skipped": 0 },
      "failures": [
        {
          "class": "com.example.demo.FailingTest",
          "test": "deliberatelyFails()",
          "durationMs": 9,
          "message": "expected: <2> but was: <1>",
          "stackTrace": "org.opentest4j.AssertionFailedError: expected: <2> but was: <1>\n\tat org.junit.jupiter.api.AssertionFailureBuilder.build(AssertionFailureBuilder.java:151)\n\t…"
        }
      ]
    }
  ]
}
```

The `stackTrace` field is the raw JUnit XML failure body. Current builds wrap it in a `<![CDATA[...]]>` envelope which is not yet stripped. The `message` field is always clean.

Success JSON goes to stdout. Failure JSON goes to stderr. Exit code is `0` when every workspace passed (or skipped), `1` if any test failed or any workspace errored.

## Single-workspace vs multi-workspace failure

Single-workspace runs rethrow compile and launcher exceptions. The CLI's top-level handler prints them. Multi-workspace runs capture the error into the per-workspace result, keep going, and exit `1` at the end if anything errored.

Test _assertions_ never throw in either mode. They surface via `ok: false` and `failures[]` so you can see every failing test in one pass.

## Error cases

| Stage    | Message pattern                                                                                            |
| -------- | ---------------------------------------------------------------------------------------------------------- |
| Compile  | `compile: javac exited with code <n> for project "<name>" (last 40 lines):\n...`                           |
| Compile  | `compile: no .java sources found under "<dir>" for project "<name>"` (only thrown for `src/`, not `test/`) |
| Launcher | `test: JUnit launcher exited with code <n> and produced no reports.\n<last 40 stderr lines>`               |
| Spawn    | `test: failed to spawn java: <reason>`. Usually no `java` on `PATH`. Install a JDK.                        |

A non-zero JUnit exit _with_ reports is treated as a normal failed run. The launcher exits `1` whenever any test fails. The "produced no reports" path only fires on real launcher problems (classpath, JVM crash, missing main class).

## See also

- [`project.json` reference](../project-json.md#testdependencies): declaring test-only deps.
- [`pluggy build`](./build.md): the same compile pipeline minus tests.
- [Testing with MockBukkit](../recipes/testing-with-mockbukkit.md): a worked recipe.
- [Troubleshooting](../troubleshooting.md): `javac` and `java` not found, and other common issues.
