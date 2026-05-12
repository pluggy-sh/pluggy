# `pluggy explain`

Print a workspace's effective project view after inheritance, with each field tagged by where it came from. Use it when you're not sure whether a value (a dependency, a JDK pin, a script) is declared locally or [inherited](../workspaces.md#inheritance) from the root.

## Usage

```text
$ pluggy explain core

core /repo/core

  name           declared   core
  version        declared   0.1.0
  description    inherited  (none)
  compatibility  inherited  {"versions":["1.21.8"],"platforms":["paper"]}
  dependencies   merged     api=workspace:api, caffeine=3.1.8 (inherited), paper-api=1.21-R0.1-SNAPSHOT (inherited)
  jdk            inherited  {"major":21}
```

Each top-level field gets one of four tags:

| Tag         | Meaning                                                                  |
| ----------- | ------------------------------------------------------------------------ |
| `declared`  | The workspace's own `project.json` sets this field.                      |
| `inherited` | The root sets it; the workspace doesn't.                                 |
| `merged`    | Both sides contributed. Used by `registries`, `dependencies`, `scripts`. |
| `absent`    | Neither side sets it; the merged view omits the field.                   |

For merged maps, each entry is suffixed `(inherited)` when only the root declared it.

## Picking the target

| Where you run              | What `explain` inspects                              |
| -------------------------- | ---------------------------------------------------- |
| Inside a workspace         | That workspace.                                      |
| At the root, no argument   | The root's own project (only useful for standalone). |
| At the root, with `[name]` | That named workspace.                                |

At a root with workspaces and no `[name]`, `explain` errors with the list of known workspace names. Pass one explicitly.

## Examples

Inspect a specific workspace from the root:

```text
$ pluggy explain api
```

Inspect the current workspace:

```text
$ cd plugin
$ pluggy explain
```

Pipe the JSON view into `jq`:

```text
$ pluggy explain core --json | jq '.project.dependencies'
```

## JSON envelope

```json
{
  "status": "success",
  "exitCode": 0,
  "name": "core",
  "rootDir": "/repo/core",
  "project": {
    "name": "core",
    "version": "0.1.0",
    "compatibility": { "versions": ["1.21.8"], "platforms": ["paper"] },
    "dependencies": { "api": { "source": "workspace:api", "version": "*" } }
  },
  "origins": {
    "name": "declared",
    "compatibility": "inherited",
    "dependencies": "merged",
    "description": "absent"
  }
}
```

## See also

- [Workspaces: inheritance](../workspaces.md#inheritance): which fields cascade from root.
- [`pluggy workspaces`](./workspaces.md): the workspace listing command.
- [`pluggy why`](./why.md): trace which top-level dependency pulled in a transitive.
