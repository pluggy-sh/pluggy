# `pluggy build`

Compile Java sources, stage resources, generate the platform [descriptor](../glossary.md#descriptor), apply [shading](../glossary.md#shade), and zip the result into a plugin jar.

## Usage

```text
pluggy build [options]
pluggy b     [options]
```

## Flags

| Flag                  | Default                                | Notes                                                                       |
| --------------------- | -------------------------------------- | --------------------------------------------------------------------------- |
| `--output <path>`     | `<workspace>/bin/<name>-<version>.jar` | Output jar destination.                                                     |
| `--clean`             | off                                    | Wipe the staging directory before building.                                 |
| `--skip-classpath`    | off                                    | Don't regenerate `.classpath` and `.project` for this build.                |
| `--workspace <names>` | none                                   | Build one or more workspaces. Repeatable; comma-separated.                  |
| `--exclude <names>`   | none                                   | Subtract one or more workspaces from the default sweep.                     |
| `--workspaces`        | off                                    | Explicit all-workspaces build from the root.                                |
| `--concurrency <n>`   | `min(cpus, 4)`                         | Cap on workspaces building simultaneously. Use `1` for serial, live output. |
| `--watch`             | off                                    | After the initial build, rebuild changed workspaces and dependents on save. |

See [Workspaces: selection flags](../workspaces.md#selection-flags) for the shared `--workspace` / `--exclude` syntax.

## Scope rules

| Location                       | Flags                   | Builds                                  |
| ------------------------------ | ----------------------- | --------------------------------------- |
| Standalone project             | none                    | The project.                            |
| Inside workspace `X`           | none                    | `X`.                                    |
| Repo root, workspaces declared | none                    | Every workspace, topologically ordered. |
| Repo root, workspaces declared | `--workspace A`         | Just `A`.                               |
| Inside workspace `X`           | `--workspaces`          | **Error**. Only valid at the root.      |
| Inside workspace `X`           | `--workspace Y` (Y ≠ X) | **Error**. Run from the root.           |

[Topological order](../glossary.md#topological-order) is driven by `workspace:` dependencies. A sibling's built jar must exist before a workspace that shades it builds. Running from the root handles this for you.

If you build a workspace whose `workspace:` dep hasn't been produced yet (typical for `pluggy build --workspace plugin` without building `api` first), pluggy stops with a clear error pointing at the missing sibling: `workspace dependency "api" has not been built yet`. Run `pluggy build --workspace api` first or omit `--workspace` to build the whole graph.

## Parallel execution

At `--concurrency > 1`, independent workspaces build simultaneously. The runner respects the workspace dependency graph: a workspace whose upstream failed is settled as `skipped-upstream-failed` without trying to compile (its dep jar wouldn't exist). Output is buffered per workspace and flushed as a block when that workspace finishes, so multi-workspace runs stay readable.

For live, interleaved output (long single-workspace iteration), pass `--concurrency 1`.

## Watch mode

`pluggy build --watch` runs an initial build, then watches `src/`, the paths referenced by `project.resources`, and `project.json` across every selected workspace. On change, the affected workspace and every transitive downstream dependent rebuild in topological order. Changes during a build queue and drain once the in-flight rebuild finishes; bursts of saves don't stack.

```text
$ pluggy build --watch
✓ api → /repo/api/bin/api-0.1.0.jar (0.3 KB, 1802ms)
✓ core → /repo/core/bin/core-0.1.0.jar (0.5 KB, 1903ms)
✓ plugin → /repo/plugin/bin/plugin-1.0.0.jar (1.8 KB, 2210ms)
  → watching 3 workspaces (api, core, plugin); ctrl-c to stop

Rebuild triggered for 2 workspaces (core, plugin)
✓ core → /repo/core/bin/core-0.1.0.jar (0.5 KB, 1745ms)
✓ plugin → /repo/plugin/bin/plugin-1.0.0.jar (1.8 KB, 2102ms)
```

`--watch` is for tight iteration loops. For a running test server that reloads on rebuild, use [`pluggy dev`](./dev.md).

## Pipeline

For each target workspace, pluggy runs the steps below in order. Every step lives in its own module under `src/build/`.

1. **Pick the descriptor.** Check that every declared platform shares the same [descriptor family](../glossary.md#descriptor-family). Errors with "Split them into separate workspaces, one per family." if they don't.
2. **Stage directory.** Under `<workspace>/.pluggy-build/<hash>/`, where `<hash>` is the first 12 hex chars of `sha256(name \0 version \0 rootDir)`. `--clean` wipes this first.
3. **Resolve dependencies.** Every declared dep, plus the primary platform's `api()` Maven coordinate. Registries are the platform's own repos first, followed by `project.registries`, with order-preserving dedup.
4. **Write IDE files.** Writes `.classpath` and `.project` at the project root unless `--skip-classpath` was passed. Failures are logged at debug but don't abort the build.
5. **Stage resources.** Copy `project.resources` into the staging dir, and run `.yml`, `.yaml`, `.json`, `.properties`, `.txt`, and `.md` files through the `${project.x}` template substitution.
6. **Generate the descriptor.** Unless a resource entry already claims the descriptor path (`plugin.yml` and friends), pluggy writes the generated one to the staging dir.
7. **Compile.** `javac -encoding UTF-8 -d <staging> -cp <classpath> <sources>`. The classpath separator is `:` on POSIX and `;` on Windows, handled by Node's `path.delimiter`.
8. **Shade.** For each entry in `project.shading`, unzip the matching `include` entries from the dep jar and write them into the staging dir. `exclude` is subtracted after.
9. **Zip.** Walk the staging dir, sort entries lexicographically, write a zip with forward-slashed entry paths.
10. **Platform compile-check.** For every non-primary platform declared in `compatibility.platforms` (`platforms[1..]`), pluggy runs `checkPlatformCompile`: a `javac` invocation against that platform's API jar with no artifacts emitted. The primary platform was already compiled in step 7, so this catches cases where your source is Paper-clean but references a symbol missing on Spigot, Folia, or a Bungee-family platform. A failing check logs a warning and sets the exit code to `1`, but the primary jar still ships.

The output jar is written to `<output>` after the staging dir is zipped.

## Output

Human, single workspace:

```text
Building my_plugin
✓ my_plugin → /repo/bin/my_plugin-1.0.0.jar (142.4 KB, 3821ms)
```

Human, multi-workspace:

```text
Building api
✓ api → /repo/api/bin/api-1.0.0.jar (42.1 KB, 1802ms)
Building impl
✓ impl → /repo/impl/bin/impl-1.0.0.jar (98.3 KB, 2103ms)

Summary
  api → /repo/api/bin/api-1.0.0.jar (42.1 KB, 1802ms)
  impl → /repo/impl/bin/impl-1.0.0.jar (98.3 KB, 2103ms)
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

Single-workspace builds rethrow the first exception. The CLI's top-level handler prints it. Multi-workspace builds continue past a failed workspace, report everyone's status in the summary, and exit `1` if anything failed.

## Error cases

Common failure modes (see [Troubleshooting](../troubleshooting.md) for
the full list):

| Stage      | Message pattern                                                                                                                                                                |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Descriptor | `build: project "<name>" declares platforms from different descriptor families ...`                                                                                            |
| Compile    | `compile: javac exited with code <n> for project "<name>" (last 40 lines):\n...`                                                                                               |
| Compile    | `compile: no .java sources found under "<dir>" for project "<name>"`                                                                                                           |
| Shade      | `shade: workspace dependency "<name>" has not been built yet, expected jar at "<path>". Build the sibling workspace first (topological order is the caller's responsibility).` |
| Resource   | `resources: source path "<rel>" (key "<k>") does not exist at "<abs>"`                                                                                                         |

## See also

- [Build pipeline](../build-pipeline.md): the same steps with more depth.
- [IDE integration](../ide.md): which IDEs consume the generated `.classpath`.
- [Workspaces](../workspaces.md): topological build order.
