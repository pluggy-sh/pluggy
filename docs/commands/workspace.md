# `pluggy workspace`

Everything that inspects or changes the workspace graph. Bare `pluggy workspace` runs `list`, so the read-only answer is one word away.

| Subcommand                            | Purpose                                                           |
| ------------------------------------- | ----------------------------------------------------------------- |
| `pluggy workspace list`               | Print every workspace's role, platforms, siblings, and output.    |
| `pluggy workspace add <name>`         | Scaffold a new workspace and wire it into the root.               |
| `pluggy workspace remove <name>`      | Unwire a workspace (and optionally delete its files).             |
| `pluggy workspace rename <old> <new>` | Rename a workspace and rewrite every `workspace:<old>` reference. |
| `pluggy workspace graph`              | Render the sibling dependency graph as text or Mermaid.           |

To see which fields a single workspace declared and which it inherited from the root, run [`pluggy why <workspace>`](./why.md#workspace-names).

`pluggy workspaces` and `pluggy graph` are gone. Typing either names its replacement and exits 2.

## `list`

List every workspace declared in the current project, in [topological order](../glossary.md#topological-order).

```text
$ pluggy workspace list

NAME    ROLE      PLATFORMS  DEPENDS-ON  OUTPUT
api     shipping  paper      -           /repo/api/bin/api-0.1.0.jar
core    shipping  paper      api         /repo/core/bin/core-0.1.0.jar
plugin  shipping  paper      api, core   /repo/plugin/bin/plugin-1.0.0.jar
```

`DEPENDS-ON` lists only workspaces in this repo. External Modrinth and Maven deps are intentionally omitted; [`pluggy list`](./list.md) covers those.

| Role       | Meaning                                                                                    |
| ---------- | ------------------------------------------------------------------------------------------ |
| `shipping` | Has a `main` class. Gets loaded by a platform server and produces a deployable plugin jar. |
| `internal` | Has no `main`. Library workspace consumed by siblings via `workspace:` deps.               |

The root project is not listed. It isn't a build target. A project with no `workspaces` declared exits 0 with an empty list:

```text
$ pluggy workspace list
No workspaces declared. (Add a `workspaces` array to project.json.)
```

## `add`

Scaffold a new workspace under the root and wire it into the root's `workspaces` array.

```text
$ pluggy workspace add core --depends api

Added workspace core
  › → /repo/core/project.json
  › → updated /repo/project.json
```

`add` runs four steps in order:

1. Validate `<name>` (starts with a letter; letters, digits, `.`, `_`, and `-` only; no collision with an existing workspace).
2. Verify the target directory doesn't already exist.
3. Write the child `project.json` and its Java stub first.
4. Update the root's `workspaces` array second.

The order matters for crash recovery. A failure between step 3 and step 4 leaves an unreferenced folder on disk (easy to remove); the inverse would leave a dangling reference that the next workspace command hard-fails on.

### Flags

| Flag                         | Effect                                                                                                                                          |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `--main <fqcn>`              | Entry-point class. Derived from the root's package when omitted.                                                                                |
| `--platform <ids>`           | Platforms for this workspace (repeatable; comma-separated). Omit to inherit `compatibility` from root. Validated against the platform registry. |
| `--depends <list>`           | Comma-separated workspace names to wire as `workspace:<name>` deps.                                                                             |
| `--dir <path>`               | Override the on-disk directory. Defaults to `./<name>`.                                                                                         |
| `--project-version <semver>` | Initial `version`. Defaults to `0.1.0`.                                                                                                         |

Every buildable workspace is a plugin, so `add` always writes a `main` and a matching Java stub. Without `--main` it derives one from the root project's package: root `com.example.suite.Main` plus workspace `core` gives `com.example.suite.core.Core`. A root with no `main` falls back to the `com.example` package.

```text
$ pluggy workspace add util
$ cat util/project.json
{
  "name": "util",
  "version": "0.1.0",
  "main": "com.example.util.Util"
}
```

The stub lands at the matching package path (`util/src/com/example/util/Util.java`), so `pluggy build` succeeds on the workspace immediately.

Add a shipping workspace with an explicit main class and platform pin:

```text
$ pluggy workspace add plugin --main com.example.MyPlugin --platform paper --depends api,core
```

## `remove`

Unwire a workspace from the root. The workspace's files stay on disk by default.

```text
$ pluggy workspace remove core

Removed workspace core
  › → unwired from /repo/project.json
  › → files left at /repo/core
```

`remove` refuses to unwire a workspace that other workspaces declare a `workspace:` dependency on:

```text
$ pluggy workspace remove api
error [E_WORKSPACE_HAS_DEPENDENTS]: cannot remove "api": workspaces "core", "plugin" depend on it
  hint: Remove the dependents first, or pass --force to unwire anyway (their builds will break).
```

### Flags

| Flag        | Effect                                                                               |
| ----------- | ------------------------------------------------------------------------------------ |
| `--delete`  | Recursively delete the workspace's directory after unwiring. Prompts unless `--yes`. |
| `-y, --yes` | Skip the `--delete` confirmation prompt. Required with `--json`.                     |
| `--force`   | Unwire even when other workspaces declare `workspace:<name>` deps.                   |

`--delete` removes source code, so it never runs silently. Outside a terminal (CI, `--json`) it fails with `E_CONFIRM_REQUIRED` unless `--yes` is passed. Declining the prompt exits 0 with `status: "aborted"` and changes nothing.

## `rename`

Rename a workspace and rewrite every `workspace:<old>` reference across siblings and the root.

```text
$ pluggy workspace rename api shared

Renamed workspace api → shared
  › → /repo/api/project.json
  › → rewrote workspace:api → workspace:shared in 2 siblings
```

What gets rewritten:

- The renamed workspace's own `project.name`.
- Every sibling's `dependencies` and `testDependencies` entries whose `source` is `workspace:<old>`. The dep's key is renamed too, so it keeps matching the workspace name.
- The root's `dependencies` and `testDependencies` if they referenced the workspace.

The on-disk directory keeps its old name. Move it yourself afterwards and update the root's `workspaces` array if you want the two to match.

`rename` refuses an invalid identifier (same rules as `add`), a name already in use, and a new name that collides with an unrelated dep declaration (`E_WORKSPACE_RENAME_COLLISION`). The collision check runs across every project file before the first write, so a rejected rename leaves nothing half-applied.

## `graph`

Render the sibling dependency graph. The graph is derived from each workspace's `workspace:` dependencies (see [Workspaces: `workspace:` dependencies](../workspaces.md#workspace-dependencies)). Modrinth, Maven, and file sources don't appear: this answers "what depends on what in this repo," not "what's on the classpath."

```text
$ pluggy workspace graph

Workspace graph
  a → b: a depends on b
  api
  core → api
  plugin → api, core
```

The arrow reads "depends on". Nodes appear in [topological order](../glossary.md#topological-order), so each line's dependencies are listed above it.

`--format mermaid` emits a `graph TD` definition instead:

```text
$ pluggy workspace graph --format mermaid
graph TD
  api["api"]
  core["core"]
  plugin["plugin"]
  core --> api
  plugin --> api
  plugin --> core
```

Paste the block into a GitHub Markdown file inside a fenced `mermaid` code block and the graph renders inline. Workspace names containing `.` or `-` are sanitized to identifiers; the original name is preserved as the node label.

`--mermaid` was replaced by `--format mermaid`.

A project with no workspaces exits 0 with an empty graph, which is the right answer for a single-`project.json` project:

```text
$ pluggy workspace graph
No workspaces declared. For the dependency tree, run `pluggy list --tree`.
```

## JSON envelopes

Every subcommand emits a single object under `--json`.

`list` carries its own versioned envelope. We commit to the v1 shape; future additions append fields without breaking existing scripts.

```json
{
  "schemaVersion": 1,
  "workspaces": [
    {
      "name": "api",
      "rootDir": "/repo/api",
      "role": "shipping",
      "main": "com.example.shop.api.Api",
      "platforms": ["paper"],
      "dependsOn": [],
      "outputPath": "/repo/api/bin/api-0.1.0.jar"
    }
  ]
}
```

`main` is `null` for internal workspaces and the FQCN string for shipping ones.

`graph` emits the node and edge lists, plus a `mermaid` string when `--format mermaid` is set:

```json
{
  "status": "success",
  "exitCode": 0,
  "nodes": ["api", "core", "plugin"],
  "edges": [
    { "from": "core", "to": "api" },
    { "from": "plugin", "to": "api" },
    { "from": "plugin", "to": "core" }
  ]
}
```

The three mutating subcommands carry `status: "success"`, `exitCode: 0`, and their own fields:

- `add`: `name`, `workspaceDir`, `projectFile`, `rootProjectFile`.
- `remove`: `name`, `workspaceDir`, `rootProjectFile`, `deletedFiles`.
- `rename`: `oldName`, `newName`, `dependentsRewritten`.

## See also

- [Workspaces](../workspaces.md): the layout and inheritance model.
- [`pluggy why`](./why.md): where a dependency or a workspace field came from.
- [`pluggy build`](./build.md): topological ordering and the `--workspace` selection grammar.
- [`pluggy init --template multi-module`](./init.md#templates): scaffold an api/core/plugin layout from scratch.
