# `pluggy why`

Trace which top-level dependency pulled in a [transitive](../glossary.md#transitive-dependency) from `pluggy.lock`. Useful when you find an unfamiliar entry in the lockfile and need to know which dep dragged it in.

## Usage

```text
pluggy why <name>
```

`<name>` is the lockfile entry's key. For Modrinth and workspace deps that's the dep name (`worldedit`, `api`). For Maven transitives it's the full `<groupId>:<artifactId>` (`net.kyori:adventure-key`). Use [`pluggy list`](./list.md) or open `pluggy.lock` to see exact keys.

## Flags

None beyond the global `--json`.

## What it prints

Every distinct path from `<name>` up to a top-level entry, with `↳ declared by:` showing the workspaces that declared the top-level. Indentation deepens with chain length. When the entry is itself top-level, the path is just the entry plus its `declared by:` line.

## Human output

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

A transitive pulled in by two top-level deps:

```text
$ pluggy why net.kyori:examination-api
net.kyori:examination-api@1.3.0
└─ adventure-api
  ↳ declared by: my_plugin
└─ adventure-text-serializer-gson
  ↳ declared by: my_plugin
```

Each `└─` line is one parent step; multiple paths each get their own block.

## JSON output

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

`paths[].chain` is leaf-first: the queried entry, then its parents up to (and including) a top-level. `paths[].declaredBy` is the top-level's `declaredBy` from the lockfile. Empty `declaredBy` means the chain ended without reaching a declared dep (an orphan transitive, which `pluggy doctor`'s lockfile check warns about).

## Error cases

| Trigger           | Code                | Message                                                              |
| ----------------- | ------------------- | -------------------------------------------------------------------- |
| Outside a project | `E_WHY_NO_PROJECT`  | `No pluggy project found. Run this from inside a project directory.` |
| No lockfile       | `E_WHY_NO_LOCKFILE` | `No pluggy.lock found. Run pluggy install first.`                    |
| Unknown name      | `E_WHY_NOT_FOUND`   | `No lockfile entry named "<name>".`                                  |

## See also

- [`pluggy list`](./list.md): print every locked entry with its source.
- [`pluggy outdated`](./outdated.md): find stale entries in the lockfile.
- [Dependencies > Lockfile](../dependencies.md#lockfile): the lockfile schema.
