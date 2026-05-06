# `pluggy build`

Compile Java sources, stage resources, generate the platform descriptor,
apply shading, and zip the result into a plugin jar.

## Usage

```text
pluggy build [options]
pluggy b     [options]
```

## Flags

| Flag                 | Default                                | Notes                                                                                  |
| -------------------- | -------------------------------------- | -------------------------------------------------------------------------------------- |
| `--output <path>`    | `<workspace>/bin/<name>-<version>.jar` | Output jar destination.                                                                |
| `--clean`            | off                                    | Wipe the staging directory before building.                                            |
| `--skip-classpath`   | off                                    | Don't regenerate IDE project files (`.classpath`, `.vscode/settings.json`, `.idea/*`). |
| `--workspace <name>` | none                                   | Build only this workspace.                                                             |
| `--workspaces`       | off                                    | Explicit all-workspaces build from the root.                                           |

## Scope rules

| Location                       | Flags                   | Builds                                  |
| ------------------------------ | ----------------------- | --------------------------------------- |
| Standalone project             | none                    | The project.                            |
| Inside workspace `X`           | none                    | `X`.                                    |
| Repo root, workspaces declared | none                    | Every workspace, topologically ordered. |
| Repo root, workspaces declared | `--workspace A`         | Just `A`.                               |
| Inside workspace `X`           | `--workspaces`          | **Error** — only valid at the root.     |
| Inside workspace `X`           | `--workspace Y` (Y ≠ X) | **Error** — run from the root.          |

Topological order is driven by `workspace:` dependencies. A sibling's
built jar must exist before a workspace that shades it builds — running
from the root handles this for you.

## Pipeline

For each target workspace:

1. **Pick the descriptor.** Checks that every declared platform shares
   the same descriptor family; errors "Split them into separate
   workspaces — one per family." if they don't.
2. **Stage directory.** Under `<workspace>/.pluggy-build/<hash>/`, where
   `<hash>` is the first 12 hex chars of `sha256(name \0 version \0 rootDir)`.
   `--clean` wipes this first.
3. **Resolve dependencies.** Every declared dep, plus the primary
   platform's `api()` Maven coordinate. Registries are the platform's
   own repos (first) followed by `project.registries` (after), order-
   preserving dedup.
4. **Write IDE files.** If `project.ide` is set. Failures are logged at
   debug but don't abort the build.
5. **Stage resources.** Copy `project.resources` into the staging dir;
   run `.yml` / `.yaml` / `.json` / `.properties` / `.txt` / `.md` files
   through the `${project.x}` templater.
6. **Generate the descriptor.** Unless a resource entry already claims
   the descriptor path (`plugin.yml` etc.). pluggy writes the generated
   one to the staging dir.
7. **Compile.** `javac -encoding UTF-8 -d <staging> -cp <classpath>
<sources>`. Classpath separator is `:` on POSIX, `;` on Windows —
   handled by Node's `path.delimiter`.
8. **Shade.** For each entry in `project.shading`, unzip the matching
   `include` entries from the dep jar and write them into the staging
   dir. `exclude` is subtracted after.
9. **Zip.** Walk the staging dir, sort entries lexicographically, write
   a zip with forward-slashed entry paths.
10. **Platform compile-check.** For every non-primary platform declared
    in `compatibility.platforms` (i.e. `platforms[1..]`), pluggy runs
    `checkPlatformCompile` — a javac invocation against that platform's
    API jar with no artifacts emitted. The primary platform was already
    compiled in step 7, so this exists solely to catch cases where your
    source is Paper-clean but references a symbol missing on Spigot,
    Folia, or a Bungee-family platform. A failing check logs a `warn` and
    flips `exitCode` to `1`, but the primary jar still ships.

The output jar is written to `<output>` after the staging dir is zipped.

## Output

Human, single workspace:

```text
build my_plugin
✔ my_plugin: /repo/bin/my_plugin-1.0.0.jar (142.4 KB, 3821ms)
```

Human, multi-workspace:

```text
build api
✔ api: /repo/api/bin/api-1.0.0.jar (42.1 KB, 1802ms)
build impl
✔ impl: /repo/impl/bin/impl-1.0.0.jar (98.3 KB, 2103ms)

summary
  api: /repo/api/bin/api-1.0.0.jar (42.1 KB, 1802ms)
  impl: /repo/impl/bin/impl-1.0.0.jar (98.3 KB, 2103ms)
```

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
      "outputPath": "/repo/bin/my_plugin-1.0.0.jar",
      "sizeBytes": 145840,
      "durationMs": 3821,
      "platformChecks": [{ "platform": "spigot", "ok": true, "durationMs": 612 }]
    }
  ]
}
```

`platformChecks` is omitted when `compatibility.platforms` has a single
entry (nothing to cross-check). Each entry reports `{ platform, ok,
durationMs }`, plus `error` when `ok` is `false`. A failed entry sets
`status: "error"` and exits `1` even though the primary jar was still
produced.

On partial failure (multi-workspace, at least one workspace failed):

```json
{
  "status": "error",
  "results": [
    { "workspace": "api", "ok": true, "outputPath": "...", "sizeBytes": 42123, "durationMs": 1802 },
    {
      "workspace": "impl",
      "ok": false,
      "durationMs": 120,
      "error": "compile: javac exited with code 1 ..."
    }
  ]
}
```

Success JSON goes to stdout; partial-failure JSON goes to stderr.
Exit code is `0` when everything succeeds, `1` otherwise.

## Single-workspace vs multi-workspace failure

Single-workspace builds rethrow the first exception — the CLI's top-level
handler prints it. Multi-workspace builds continue past a failed
workspace, report everyone's status in the summary, and exit `1` if
anything failed.

## Error cases

Common failure modes (see [Troubleshooting](../troubleshooting.md) for
the full list):

| Stage      | Message pattern                                                                                                                                                                 |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Descriptor | `build: project "<name>" declares platforms from different descriptor families ...`                                                                                             |
| Compile    | `compile: javac exited with code <n> for project "<name>" (last 40 lines):\n...`                                                                                                |
| Compile    | `compile: no .java sources found under "<dir>" for project "<name>"`                                                                                                            |
| Shade      | `shade: workspace dependency "<name>" has not been built yet — expected jar at "<path>". Build the sibling workspace first (topological order is the caller's responsibility).` |
| Resource   | `resources: source path "<rel>" (key "<k>") does not exist at "<abs>"`                                                                                                          |

## See also

- [Build pipeline](../build-pipeline.md) — the same steps with more depth.
- [IDE integration](../ide.md) — what the `ide` field generates.
- [Workspaces](../workspaces.md) — topological build order.
