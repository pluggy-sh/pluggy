# `pluggy why`

Answer "where did this come from?" for either kind of name a project has. Pass a workspace name to see which of its fields it declared and which it inherited from the root; pass anything else to trace which top-level dependency pulled it in.

```text
pluggy why <name>
```

`why` checks the workspace list first, so when a workspace and a dependency share a name the workspace wins. The only flag is the global `--json`.

## Workspace names

Print the workspace's effective project view after [inheritance](../workspaces.md#inheritance), with each field tagged by where it came from. Reach for this when you're not sure whether a value (a dependency, a JDK pin, a script) is local or inherited.

```text
$ pluggy why core

core /repo/core

  name           declared   core
  version        declared   0.1.0
  description    inherited  A shop plugin suite.
  main           declared   com.example.shop.core.Core
  compatibility  inherited  {"versions":["1.21.8"],"platforms":["paper"]}
  dependencies   merged     api=workspace:api, paper-api=maven:io.papermc.paper:paper-api (inherited)
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

Run [`pluggy workspace list`](./workspace.md#list) for the names `why` accepts here.

### JSON envelope

```json
{
  "status": "success",
  "exitCode": 0,
  "name": "core",
  "rootDir": "/repo/core",
  "project": {
    "name": "core",
    "version": "0.1.0",
    "main": "com.example.shop.core.Core",
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

`origins` carries a tag for every known top-level field, including the ones the merged `project` omits.

## Dependency names

Trace every path from a locked entry up to a top-level dependency. Useful when you find an unfamiliar [transitive](../glossary.md#transitive-dependency) in `pluggy.lock` and need to know which dep dragged it in.

`<name>` is the lockfile entry's key. For Modrinth and workspace deps that's the dep name (`worldedit`, `api`); for Maven transitives it's the full `<groupId>:<artifactId>` (`net.kyori:adventure-key`). Run [`pluggy list`](./list.md) or open `pluggy.lock` for the exact keys.

A direct top-level dep:

```text
$ pluggy why worldedit
worldedit@7.3.15
↳ declared by: my_plugin
```

A transitive:

```text
$ pluggy why net.kyori:adventure-key
net.kyori:adventure-key@4.17.0
└─ adventure-api
  ↳ declared by: my_plugin
```

Each `└─` line is one parent step, and `↳ declared by:` names the workspaces that declared the top-level. A transitive pulled in twice gets one block per path:

```text
$ pluggy why net.kyori:examination-api
net.kyori:examination-api@1.3.0
└─ adventure-api
  ↳ declared by: my_plugin
└─ adventure-text-serializer-gson
  ↳ declared by: my_plugin
```

### JSON envelope

```json
{
  "status": "success",
  "name": "net.kyori:adventure-key",
  "version": "4.17.0",
  "paths": [
    {
      "chain": ["net.kyori:adventure-key", "adventure-api"],
      "declaredBy": ["my_plugin"]
    }
  ]
}
```

`paths[].chain` is leaf-first: the queried entry, then its parents up to and including a top-level. Empty `declaredBy` means the chain ended without reaching a declared dep, an orphan transitive that [`pluggy doctor`](./doctor.md)'s lockfile check warns about.

## Error cases

| Trigger                                     | Code                | Message                                                              |
| ------------------------------------------- | ------------------- | -------------------------------------------------------------------- |
| Outside a project                           | `E_WHY_NO_PROJECT`  | `No pluggy project found. Run this from inside a project directory.` |
| No lockfile                                 | `E_WHY_NO_LOCKFILE` | `No pluggy.lock found. Run pluggy install first.`                    |
| Name matches no workspace or lockfile entry | `E_WHY_NOT_FOUND`   | `No lockfile entry named "<name>".`                                  |

A name that isn't a workspace is looked up in the lockfile, so in a project that has never run `pluggy install` a typo'd workspace name reports the missing lockfile rather than the unknown name.

## See also

- [`pluggy workspace`](./workspace.md): list, add, remove, rename, and graph the workspaces `why` resolves against.
- [Workspaces: inheritance](../workspaces.md#inheritance): which fields cascade from the root.
- [`pluggy list`](./list.md): print every locked entry with its source.
- [`pluggy outdated`](./outdated.md): find stale entries in the lockfile.
- [Dependencies > Lockfile](../dependencies.md#lockfile): the lockfile schema.
