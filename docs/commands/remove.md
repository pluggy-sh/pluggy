# `pluggy remove`

Drop a dependency from `project.json` and optionally delete its cached jar.

## Usage

```text
pluggy remove [options] <plugin>
pluggy rm     [options] <plugin>
```

`<plugin>` is the dependency key in `project.json:dependencies`. For Modrinth it's the slug. For Maven it's the `artifactId`. For file deps it's the basename without `.jar`. For workspace deps it's the sibling name.

## Flags

| Flag                 | Default | Notes                                         |
| -------------------- | ------- | --------------------------------------------- |
| `--keep-file`        | off     | Don't delete the cached jar.                  |
| `--workspace <name>` | none    | Target a specific workspace.                  |
| `--workspaces`       | off     | Remove from every workspace that declares it. |

At a multi-workspace root you **must** pass one of `--workspace` or `--workspaces`. `remove` refuses to guess. Running a bare `pluggy remove foo` at the root errors:

```text
error: remove: at the workspace root, pass --workspace <name> or --workspaces to disambiguate
```

Contrast with `install`, which defaults to all workspaces when ambiguous. `remove` is irreversible, so the default is "explicit or nothing."

## What it does

1. Reads every targeted `project.json`, drops the entry, and writes the
   file back with a trailing LF.
2. Reads `pluggy.lock`. If the entry is still declared by a workspace that
   wasn't targeted, it shrinks `declaredBy` and stops there. Otherwise it
   deletes the lockfile entry entirely.
3. Unless `--keep-file`, best-effort-unlinks the cached jar
   (`~/Library/Caches/pluggy/dependencies/<kind>/.../<version>.jar`).

Your own source jars (the `file:./libs/foo.jar` on disk) are never touched. Only the content-addressed cache copy is deleted.

`workspace:` entries are in the lockfile but have no cached jar. `fileRemoved` stays `false` even after a successful remove.

## Scope rules

Identical to [`install`](./install.md#scope-rules), with one difference:
at a multi-workspace root, `remove` requires an explicit flag where
`install` would default to all workspaces.

## Human output

```text
$ pluggy remove worldedit
✓ Removed worldedit from my_plugin (and pluggy.lock)

$ pluggy remove --workspaces adventure-api
✓ Removed adventure-api from api, impl (and pluggy.lock)

$ pluggy remove notinstalled
"notinstalled" was not declared in the targeted workspaces; nothing to do.
```

## JSON output

```json
{
  "status": "success",
  "removed": ["my_plugin"],
  "lockEntryRemoved": true,
  "fileRemoved": true
}
```

## Error cases

| Trigger                                                     | Message                                                                                |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Missing `<plugin>`                                          | `remove: plugin name is required`                                                      |
| Targeting a specific workspace that doesn't declare the dep | `remove: "<plugin>" is not declared in <workspace> (<path>)`                           |
| Cached jar exists but can't be unlinked                     | Warning on stderr: `remove: could not delete <path>: <errno>`. Command still succeeds. |

When `--workspaces` is set and the dep isn't present in some workspaces, those are listed in the JSON `missing` field (human mode shows a count only).

## See also

- [`pluggy install`](./install.md): the counterpart.
- [`pluggy list`](./list.md): audit what's currently declared.
- [Dependencies](../dependencies.md#lockfile): lockfile shape.
