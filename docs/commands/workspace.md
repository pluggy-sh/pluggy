# `pluggy workspace`

Mutate the workspace graph: add a new workspace, remove an existing one, or rename one and rewire its dependents. The parent command takes no action of its own; pick a subcommand.

| Subcommand                            | Purpose                                                           |
| ------------------------------------- | ----------------------------------------------------------------- |
| `pluggy workspace add <name>`         | Scaffold a new workspace and wire it into the root.               |
| `pluggy workspace remove <name>`      | Unwire a workspace (and optionally delete its files).             |
| `pluggy workspace rename <old> <new>` | Rename a workspace and rewrite every `workspace:<old>` reference. |

For the read-only "what workspaces does this repo have?" answer, see [`pluggy workspaces`](./workspaces.md).

## `add`

Scaffold a new workspace under the root and wire it into the root's `workspaces` array.

```text
$ pluggy workspace add core --depends api

Added workspace core
  › /repo/core/project.json
  › updated /repo/project.json
```

Steps the command runs, in order:

1. Validate `<name>` (POSIX-safe identifier; no path traversal; must not collide with an existing workspace).
2. Verify the target directory doesn't already exist.
3. Write the child `project.json` first.
4. Update the root's `workspaces` array second.

The order matters for crash recovery. A failure between step 3 and step 4 leaves an unreferenced folder on disk (easy to remove); the inverse would leave a dangling reference that the next workspace command would hard-fail on.

### Flags

| Flag                 | Effect                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------- |
| `--main <fqcn>`      | Fully-qualified main class. Omit for an internal workspace (no `main`, no descriptor).      |
| `--platforms <list>` | Comma-separated platforms (e.g. `paper,sponge`). Omit to inherit `compatibility` from root. |
| `--depends <list>`   | Comma-separated workspace names to wire as `workspace:<name>` deps.                         |
| `--dir <path>`       | Override the on-disk directory. Defaults to `./<name>`.                                     |
| `--version <semver>` | Initial `version`. Defaults to `0.1.0`.                                                     |

### Examples

Add a shared internal `core` workspace that depends on `api`:

```text
$ pluggy workspace add core --depends api
```

Add a shipping `plugin` workspace with a main class and platform pin:

```text
$ pluggy workspace add plugin --main com.example.MyPlugin --platforms paper --depends api,core
```

When `--main` is provided, `add` also writes a minimal Java stub at the matching package path so the workspace compiles immediately.

## `remove`

Unwire a workspace from the root. By default, the workspace's files stay on disk; pass `--delete` to wipe them too.

```text
$ pluggy workspace remove core

Removed workspace core
  › unwired from /repo/project.json
  › files left at /repo/core
```

`remove` refuses to unwire a workspace that other workspaces declare a `workspace:` dependency on:

```text
$ pluggy workspace remove api
error [E_WORKSPACE_HAS_DEPENDENTS]: cannot remove "api": workspaces "core", "plugin" depend on it
  hint: Remove the dependents first, or pass --force to unwire anyway (their builds will break).
```

### Flags

| Flag       | Effect                                                             |
| ---------- | ------------------------------------------------------------------ |
| `--delete` | Recursively delete the workspace's directory after unwiring.       |
| `--force`  | Unwire even when other workspaces declare `workspace:<name>` deps. |

## `rename`

Rename a workspace and rewrite every `workspace:<old>` reference across siblings and the root.

```text
$ pluggy workspace rename api shared

Renamed workspace api → shared
  › /repo/api/project.json
  › rewrote workspace:api → workspace:shared in 2 siblings
```

What gets rewritten:

- The renamed workspace's own `project.name`.
- Every sibling's `dependencies` and `testDependencies` entries whose `source` is `workspace:<old>`. The dep's key is also renamed so it matches the new workspace name.
- The root's `dependencies` / `testDependencies` if they referenced the workspace.

The on-disk directory is not renamed. If you want the directory name to match the new workspace name, move it yourself afterwards and update the root's `workspaces` array.

`rename` refuses to overwrite an existing name and refuses an invalid identifier (same rules as `add`).

## JSON envelopes

Every subcommand returns a single JSON object under `--json`. Each carries `status: "success"`, `exitCode: 0`, and subcommand-specific fields:

- `add`: `name`, `workspaceDir`, `projectFile`, `rootProjectFile`.
- `remove`: `name`, `workspaceDir`, `rootProjectFile`, `deletedFiles`.
- `rename`: `oldName`, `newName`, `dependentsRewritten`.

## See also

- [Workspaces](../workspaces.md): the layout and inheritance model.
- [`pluggy workspaces`](./workspaces.md): list every workspace in the project.
- [`pluggy init --template multi-module`](./init.md#templates): scaffold an api/core/plugin layout from scratch.
