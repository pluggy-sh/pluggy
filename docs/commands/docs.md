# `pluggy docs`

Generate Javadoc HTML for the project. Reuses the same JDK and dependency
classpath that `pluggy build` does, so the docs see every type your code
sees, including the platform API and shaded dependencies.

## Usage

```text
pluggy docs [options]
```

## Flags

| Flag                 | Default                              | Notes                                                       |
| -------------------- | ------------------------------------ | ----------------------------------------------------------- |
| `--output <path>`    | `<workspace>/docs/<name>-<version>/` | Output directory for the generated site.                    |
| `--clean`            | off                                  | Wipe the output directory before generating.                |
| `--private`          | off                                  | Include private members. Default visibility is `protected`. |
| `--link <url>`       | none                                 | Cross-link to an external javadoc site. Repeatable.         |
| `--workspace <name>` | none                                 | Document only this workspace.                               |
| `--workspaces`       | off                                  | Explicit all-workspaces docs run from the root.             |

## Scope rules

| Location                       | Flags                   | Documents                               |
| ------------------------------ | ----------------------- | --------------------------------------- |
| Standalone project             | none                    | The project.                            |
| Inside workspace `X`           | none                    | `X`.                                    |
| Repo root, workspaces declared | none                    | Every workspace, topologically ordered. |
| Repo root, workspaces declared | `--workspace A`         | Just `A`.                               |
| Inside workspace `X`           | `--workspaces`          | **Error** — only valid at the root.     |
| Inside workspace `X`           | `--workspace Y` (Y ≠ X) | **Error** — run from the root.          |

Each workspace gets its own output tree under
`<workspace>/docs/<name>-<version>/`. There is no aggregated index across
workspaces.

## Layout

```text
<workspace>/
├── src/                          documented sources
└── docs/<name>-<version>/        generated site
    ├── index.html                landing page (open this)
    ├── allclasses-index.html
    ├── element-list
    ├── <package-path>/           one directory per package
    └── …                         stylesheet, search index, assets
```

The output directory is keyed by version so two side-by-side runs at
different versions do not clobber each other. Add `docs/` to your
`.gitignore` if you do not want generated HTML in your repo.

## Pipeline

For each target workspace:

1. **Resolve the JDK.** Same path `pluggy build` uses: `JAVA_HOME` first
   if its major matches, then the cached SDK slot, then auto-install via
   Foojay Disco. The `javadoc` binary is taken from the same `bin/`
   directory as `javac`, so docs and builds always run on the same JDK.
2. **Resolve the classpath.** Every declared dependency (with its
   transitive tree) plus the primary platform's `api()` Maven coordinate.
   Order is `dependencies` first, then `platformApiJars`, with order-
   preserving dedup. Identical to `pluggy build`'s classpath.
3. **Discover sources.** Recursive walk of `src/`. No `.java` files
   under it errors out — there is nothing to document.
4. **Run javadoc.** `javadoc -d <output> -encoding UTF-8 -docencoding
UTF-8 -charset UTF-8 -<access> --release <jdk.major> -windowtitle
   "<name> <version>" -doctitle "..." -sourcepath <src> -classpath
   <classpath> [-link <url>]... <sources>`. The classpath separator is
   `:` on POSIX, `;` on Windows, handled by Node's `path.delimiter`.
5. **Measure.** Walk the output directory and report `fileCount` plus
   total `sizeBytes`.

`-quiet` is on by default. Pass `--verbose` (or set `DEBUG=1`) to see
javadoc's per-source progress chatter. Diagnostic warnings still print
either way and are counted in the result.

## Multi-platform projects

When `compatibility.platforms` lists more than one platform, docs are
generated against the **primary** platform (the first entry). Generating
one site per platform would produce N near-identical trees with no clear
way for a reader to pick between them.

If you need to document against a non-primary platform, run from a
workspace that lists that platform first or split the project into one
workspace per platform.

## Cross-linking

`--link` is repeatable and threaded straight through to javadoc as
`-link <url>`. Use it to make types from other libraries clickable in
the generated HTML.

```text
pluggy docs \
  --link https://docs.oracle.com/en/java/javase/21/docs/api/ \
  --link https://jd.papermc.io/paper/1.21/
```

Pluggy does not auto-link the platform API. The URL scheme varies per
platform and version, so we leave the choice to you.

## Output

Human, single workspace:

```text
docs my_plugin
✔ my_plugin: /repo/docs/my_plugin-1.0.0 (32 files, 259.0 KB, 1 warning, 5809ms)
```

Human, multi-workspace:

```text
docs api
✔ api: /repo/api/docs/api-1.0.0 (28 files, 210.4 KB, 1212ms)
docs impl
✔ impl: /repo/impl/docs/impl-1.0.0 (45 files, 380.1 KB, 1845ms)

summary
  api: /repo/api/docs/api-1.0.0 (28 files, 210.4 KB, 1212ms)
  impl: /repo/impl/docs/impl-1.0.0 (45 files, 380.1 KB, 1845ms)
```

The `N warning(s)` suffix only appears when javadoc emitted at least one
diagnostic.

## JSON output

On success:

```json
{
  "status": "success",
  "results": [
    {
      "workspace": "my_plugin",
      "rootDir": "/repo",
      "ok": true,
      "outputPath": "/repo/docs/my_plugin-1.0.0",
      "fileCount": 32,
      "sizeBytes": 265253,
      "warnings": 1,
      "durationMs": 5588
    }
  ]
}
```

On partial failure (multi-workspace, at least one workspace failed):

```json
{
  "status": "error",
  "results": [
    {
      "workspace": "api",
      "ok": true,
      "outputPath": "/repo/api/docs/api-1.0.0",
      "fileCount": 28,
      "sizeBytes": 215444,
      "warnings": 0,
      "durationMs": 1212
    },
    {
      "workspace": "impl",
      "ok": false,
      "durationMs": 87,
      "error": "docs: javadoc exited with code 1 ..."
    }
  ]
}
```

Success JSON goes to stdout; partial-failure JSON goes to stderr. Exit
code is `0` when every workspace succeeded, `1` otherwise.

## Single-workspace vs multi-workspace failure

Single-workspace runs rethrow the first exception so the CLI's top-level
handler prints it. Multi-workspace runs capture the error into the
per-workspace result, keep going, and exit `1` at the end if anything
failed.

## Error cases

| Stage   | Message pattern                                                                        |
| ------- | -------------------------------------------------------------------------------------- |
| Sources | `docs: no .java sources found under "<dir>" for project "<name>"`                      |
| Javadoc | `docs: javadoc exited with code <n> for project "<name>" (last 40 lines):\n...`        |
| Spawn   | `docs: failed to spawn javadoc for project "<name>": <reason>` — usually a broken JDK. |

## See also

- [`pluggy build`](./build.md) — same JDK and classpath, different output.
- [Build pipeline](../build-pipeline.md) — how the classpath is assembled.
- [Troubleshooting](../troubleshooting.md) — `javac` / `javadoc` not found, etc.
