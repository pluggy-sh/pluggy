# `pluggy clean`

Remove build outputs from the selected workspaces. Scope respects the same flags as `build`, `test`, and `docs`.

`clean` only touches conventional build artifacts. It never deletes source code, `project.json`, the lockfile, IDE files (`.classpath`, `.project`, `.idea/`), or anything under the user cache. For the user cache, see [`pluggy cache clean`](./cache.md#clean).

## What gets removed

| Directory                        | Removed?           |
| -------------------------------- | ------------------ |
| `<workspace>/bin/`               | always             |
| `<workspace>/docs/`              | only with `--docs` |
| `<workspace>/.classpath`         | never              |
| `<workspace>/.project`           | never              |
| `<workspace>/.idea/`             | never              |
| Outputs written via `--output X` | never (off-path)   |
| User cache, lockfile, sources    | never              |

## Usage

```text
$ pluggy clean

clean removed 3 paths
  › api: /repo/api/bin
  › core: /repo/core/bin
  › plugin: /repo/plugin/bin
```

At the repo root, `clean` sweeps every workspace by default. Inside a workspace, it scopes to that one.

## Flags

| Flag                  | Effect                                                                  |
| --------------------- | ----------------------------------------------------------------------- |
| `--workspace <names>` | Limit the sweep to one or more workspaces. Repeatable; comma-separated. |
| `--exclude <names>`   | Subtract one or more workspaces from the default sweep.                 |
| `--workspaces`        | Explicit "every workspace" at the root.                                 |
| `--docs`              | Also remove `<workspace>/docs/` directories.                            |
| `--dry-run`           | Print what would be removed without touching disk.                      |

`--workspace` and `--exclude` share the syntax used by `build`, `test`, and `docs`. See [Workspaces: selection flags](../workspaces.md#selection-flags).

## Examples

Clean only the `core` workspace:

```text
$ pluggy clean --workspace core
clean removed 1 path
  › core: /repo/core/bin
```

Clean everything except `core`:

```text
$ pluggy clean --exclude core
```

See what would be removed, then run it:

```text
$ pluggy clean --dry-run
clean would remove 3 paths
  › api: /repo/api/bin
  › core: /repo/core/bin
  › plugin: /repo/plugin/bin
$ pluggy clean
```

Wipe both build outputs and generated javadocs:

```text
$ pluggy clean --docs
```

## JSON envelope

`--json` emits a single object on stdout:

```json
{
  "status": "success",
  "exitCode": 0,
  "entries": [{ "workspace": "api", "path": "/repo/api/bin", "removed": true }],
  "removed": ["/repo/api/bin"]
}
```

In dry-run mode the field is `wouldRemove` instead of `removed`, and `status` is `"dry-run"`.

## See also

- [`pluggy build`](./build.md): the source of `bin/` outputs.
- [`pluggy docs`](./docs.md): the source of `docs/` outputs.
- [`pluggy cache`](./cache.md): for the user cache (JDKs, server jars, deps), not `bin/` outputs.
