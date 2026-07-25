# `pluggy list`

Print declared dependencies, their resolved versions, and the registries in scope.

## Usage

```text
pluggy list [options]
pluggy ls   [options]
```

## Flags

| Flag                  | Default | Notes                                                        |
| --------------------- | ------- | ------------------------------------------------------------ |
| `--tree`              | off     | Draw a dependency tree with transitives (from the lockfile). |
| `--workspace <names>` | none    | Show one specific workspace.                                 |
| `--workspaces`        | off     | Aggregate across every workspace.                            |

`list` reads one workspace at a time. `--workspace` accepts the [shared repeatable grammar](../workspaces.md#selection-flags), but naming more than one workspace fails with `E_WORKSPACE_NOT_SINGLE`; use `--workspaces` for the aggregated view.

For "which of these have a newer version upstream?", run [`pluggy outdated`](./outdated.md).

### Scope rules

| Location                       | Flags             | Shows                      |
| ------------------------------ | ----------------- | -------------------------- |
| Standalone project             | none              | Root.                      |
| Inside a workspace             | none              | That workspace only.       |
| Repo root, workspaces declared | none              | All workspaces aggregated. |
| Repo root, workspaces declared | `--workspaces`    | Same (explicit).           |
| Anywhere                       | `--workspace <n>` | Just that workspace.       |

When aggregating across workspaces, dependency entries are deduplicated by
name and the `declaredBy` field lists every workspace that declared them.

## Human output

### Default

```text
standalone: my_plugin

dependencies:
  worldedit    declared: 7.3.15  resolved: 7.3.15  modrinth:worldedit
  adventure-api  declared: 4.17.0  resolved: 4.17.0  maven:net.kyori:adventure-api

registries:
  https://repo.papermc.io/repository/maven-public/
```

### `--tree`

```text
standalone: my_plugin

dependencies:
  └── adventure-api  @4.17.0 → 4.17.0  maven:net.kyori:adventure-api
      └── net.kyori:adventure-key  @4.17.0 → 4.17.0  maven:net.kyori:adventure-key
          ├── net.kyori:examination-api  @1.3.0 → 1.3.0  maven:net.kyori:examination-api
          │   └── org.jetbrains:annotations  @22.0.0 → 22.0.0  maven:org.jetbrains:annotations
          └── net.kyori:examination-string  @1.3.0 → 1.3.0  maven:net.kyori:examination-string

registries:
  └── https://repo1.maven.org/maven2/
```

Transitives are sourced from the lockfile. They're only populated for Maven dependencies (other kinds have no transitive closure).

## JSON output

```json
{
  "status": "success",
  "scope": "workspace",
  "target": "my_plugin",
  "deps": [
    {
      "name": "worldedit",
      "source": { "kind": "modrinth", "slug": "worldedit", "version": "7.3.15" },
      "declaredVersion": "7.3.15",
      "resolvedVersion": "7.3.15",
      "integrity": "sha256-...",
      "declaredBy": ["my_plugin"],
      "children": []
    }
  ],
  "registries": [
    { "url": "https://repo.papermc.io/repository/maven-public/", "authenticated": false }
  ]
}
```

Registry `credentials` never appear in the output. Authentication presence
is signalled by the `authenticated` boolean.

## Error cases

| Trigger                          | Message                                                                                            |
| -------------------------------- | -------------------------------------------------------------------------------------------------- |
| Not inside a pluggy project      | `No pluggy project found. Run this from inside a project directory.` (`E_LIST_NO_PROJECT`, exit 2) |
| Unknown `--workspace` name       | `workspace not found: "<n>". known workspaces: ...`                                                |
| More than one `--workspace` name | `list works on one workspace, but 2 were selected (api, core).` (`E_WORKSPACE_NOT_SINGLE`, exit 2) |

## See also

- [Dependencies](../dependencies.md#lockfile): what the lockfile fields mean.
- [`pluggy install`](./install.md): add or refresh entries.
- [`pluggy outdated`](./outdated.md): which locked deps have a newer upstream version.
- [`pluggy info`](./info.md): richer metadata for one slug.
