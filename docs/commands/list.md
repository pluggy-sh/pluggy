# `pluggy list`

Print declared dependencies, their resolved versions, and the registries in scope.

## Usage

```text
pluggy list [options]
pluggy ls   [options]
```

## Flags

| Flag                 | Default | Notes                                                          |
| -------------------- | ------- | -------------------------------------------------------------- |
| `--tree`             | off     | Draw a dependency tree with transitives (from the lockfile).   |
| `--outdated`         | off     | Only show Modrinth deps with a newer stable version available. |
| `--workspace <name>` | none    | Show one specific workspace.                                   |
| `--workspaces`       | off     | Aggregate across every workspace.                              |

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

### `--outdated`

For each Modrinth-sourced dep, pluggy fetches the latest stable version and compares it against the locked `resolvedVersion`. Results are filtered down to only the outdated entries. Non-Modrinth deps (Maven, file, workspace) have `latestVersion: null` and never appear in the filtered list. Network failures degrade to "un-annotated" so the dep doesn't become a false positive.

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
  ├── worldedit  @7.3.15 → 7.3.15  modrinth:worldedit
  └── adventure-api  @4.17.0 → 4.17.0  maven:net.kyori:adventure-api
      ├── adventure-key  @4.17.0 → 4.17.0  maven:net.kyori:adventure-key
      └── examination-api  @1.3.0 → 1.3.0  maven:net.kyori:examination-api

registries:
  └── https://repo.papermc.io/repository/maven-public/
```

Transitives are sourced from the lockfile. They're only populated for Maven dependencies (other kinds have no transitive closure).

### `--outdated`

```text
standalone: my_plugin

outdated dependencies:
  worldedit  declared: 7.3.15  resolved: 7.3.15  → 7.4.0  modrinth:worldedit

registries:
  https://repo.papermc.io/repository/maven-public/
```

When nothing is outdated, you get `(everything is up to date)`.

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

Under `--outdated`, each `deps[]` entry additionally carries:

- `latestVersion`: the newest Modrinth stable version, or `null` for non-Modrinth deps and query failures.
- `outdated`: `true` only for entries where `latestVersion` is known and differs from `resolvedVersion`.

## Error cases

| Trigger                     | Message                                             |
| --------------------------- | --------------------------------------------------- |
| Not inside a pluggy project | `not inside a pluggy project (from <cwd>)`          |
| Unknown `--workspace` name  | `workspace not found: "<n>". known workspaces: ...` |

## See also

- [Dependencies](../dependencies.md#lockfile): what the lockfile fields mean.
- [`pluggy install`](./install.md): add or refresh entries.
- [`pluggy info`](./info.md): richer metadata for one slug.
