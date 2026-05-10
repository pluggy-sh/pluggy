# `pluggy install`

Add a [dependency](../glossary.md#dependency), refresh the [lockfile](../glossary.md#lockfile), or both.

## Usage

```text
pluggy install [options] [plugin]
pluggy i       [options] [plugin]
```

Two modes:

- `pluggy install` with no argument resolves every declared dep against `pluggy.lock`. It re-resolves anything that drifted and skips the rest.
- `pluggy install <identifier>` adds or updates one dep in the target workspace's `project.json` and folds it into the lockfile.

## Flags

| Flag                 | Default | Notes                                                 |
| -------------------- | ------- | ----------------------------------------------------- |
| `--force`            | off     | Re-resolve every dep even when the lockfile is fresh. |
| `--beta`             | off     | Include Modrinth pre-release versions.                |
| `--workspace <name>` | none    | Target a specific workspace.                          |
| `--workspaces`       | off     | Act across every workspace (only valid at the root).  |

`--workspaces` and `<plugin>` are mutually exclusive. You can't add one dep to every workspace at once. Pick `--workspace <name>` instead.

## Dependency identifier grammar

| Form                    | Example                                            |
| ----------------------- | -------------------------------------------------- |
| Modrinth slug           | `worldedit`                                        |
| Modrinth slug + version | `worldedit@7.3.15`                                 |
| Local file              | `./libs/my-lib.jar` (or any path ending in `.jar`) |
| Maven coordinate        | `maven:net.kyori:adventure-api@4.17.0`             |
| Workspace sibling       | `workspace:api`                                    |

Full grammar: [Dependencies](../dependencies.md#the-cli-identifier-grammar).

## Scope rules

The "target workspace" depends on where you run the command and which flags are set.

| Location                          | `--workspace` | `--workspaces` | Targets                    |
| --------------------------------- | ------------- | -------------- | -------------------------- |
| Inside workspace `X`              | unset         | unset          | `X`                        |
| Repo root, no workspaces declared | n/a           | n/a            | root                       |
| Repo root, workspaces declared    | unset         | unset          | every workspace            |
| Repo root, workspaces declared    | `A`           | unset          | `A`                        |
| Repo root, workspaces declared    | unset         | yes            | every workspace (explicit) |

With a specific `<plugin>`, installing at a multi-workspace root without `--workspace` fails:

```text
error: install: at the workspace root, pass --workspace <name> to pick a target for "<plugin>"
```

## What it writes

Single-identifier install (`pluggy install <plugin>`):

- Rewrites the target workspace's `project.json`, adding the dep in long form with the resolved concrete version.
- Rewrites `pluggy.lock` at the repo root, adding or updating the entry.

Bulk install (`pluggy install`):

- Resolves every declared dep across the target scope.
- Skips entries whose lockfile rows match declared `(source, version)`.
- Drops orphaned lockfile entries (locked but no longer declared anywhere).
- Rewrites `pluggy.lock`.

Bulk install never rewrites `project.json`. It's a reconcile, not an add.

## Conflict handling

Workspaces can declare the same dep as long as their `(source, version)` pairs match. When two workspaces pin different versions, install fails:

```text
error: install: conflicting declarations of "adventure-api" across workspaces:
  maven:net.kyori:adventure-api@4.17.0 vs maven:net.kyori:adventure-api@4.18.0
```

Fix this in `project.json` before `install` will touch the lockfile.

## Human output

```text
$ pluggy install worldedit
✓ Installed worldedit into my_plugin (1 resolved)

$ pluggy install
✓ Installed 3 dependencies

$ pluggy install                 # (lockfile was already fresh)
lockfile is fresh; nothing to install.
```

## JSON output

```json
{
  "status": "success",
  "installed": ["worldedit"],
  "skipped": []
}
```

## Error cases

| Trigger                            | Message pattern                                                                                           |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Unknown slug                       | `Modrinth API request failed for slug "<slug>": 404 Not Found ...`                                        |
| Unknown Maven coord                | `Maven: could not resolve "<g>:<a>:<v>" from any configured registry. Tried: ...`                         |
| Missing registries for a Maven dep | `Maven: no registries configured for "<g>:<a>:<v>". Declare a Maven registry in project.json:registries.` |
| Missing local file                 | `file source not found or unreadable: "<path>" (resolved to "<abs>"): ENOENT: ...`                        |
| Workspace without `<name>`         | `workspace not found: "<name>". known workspaces: ...`                                                    |
| Ambiguous root scope               | `install: at the workspace root, pass --workspace <name> to pick a target for "<plugin>"`                 |

## See also

- [Dependencies](../dependencies.md): the source grammar and lockfile.
- [`pluggy remove`](./remove.md): remove a dependency.
- [`pluggy list`](./list.md): verify what's currently declared and locked.
