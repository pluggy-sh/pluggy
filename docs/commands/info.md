# `pluggy info`

Inspect a dependency identifier. Works for every [source kind](../glossary.md#source-kind), online and offline.

## Usage

```text
pluggy info <plugin>
pluggy show <plugin>
```

`<plugin>` is any identifier accepted by `install`: a Modrinth slug, a Maven coordinate, a local jar path, or `workspace:<name>`.

## Flags

None beyond the global `--json`.

## What each source kind returns

### Modrinth

Hits `GET /v2/project/<slug>` and `GET /v2/project/<slug>/version`. Returns title, description, homepage, license, and every published version with its release type and date. Inside a pluggy project, each version is annotated with a compatibility hint against `compatibility.versions`: `"ok"` if any `game_versions` overlap, `"warn"` otherwise.

Human output:

```text
WorldEdit  (worldedit)
WorldEdit, in-game Minecraft map editor
homepage: https://github.com/EngineHub/WorldEdit
license:  GPL-3.0-or-later
url:      https://modrinth.com/plugin/worldedit

versions:
  7.3.15  release  2025-08-04T10:15:00Z  [ok]
  7.3.14  release  2025-07-02T12:00:00Z  [warn]
  ...
```

### Maven

No registry index lookup. pluggy doesn't know how to list Maven artifacts. Returns the coordinate and the requested version as a passthrough.

```text
maven:net.kyori:adventure-api
version: 4.17.0
no version list available (Maven registries don't expose a uniform index; use your registry's UI)
```

### File

Stats the local file, hashes the bytes, and returns the absolute path,
size in bytes, and `sha256-<hex>` integrity string.

```text
file:/abs/path/to/my-lib.jar
size:      48213 bytes
integrity: sha256-e93c...
```

Fails with `file not found: <abs> (from identifier "<raw>")` when the
path doesn't exist, and `not a regular file: <abs>` when it points at a
directory.

### Workspace

Looks up the sibling in the current `WorkspaceContext`. Returns name,
version, main class, root directory, and `project.json` path.

```text
workspace:api
version: 1.0.0
main:    com.example.api.Api
root:    /repo/api
```

From outside a pluggy project:

```text
error: workspace:<name>: not inside a pluggy project (workspace identifiers are only meaningful within a repo)
```

## JSON output

Every source kind returns a JSON envelope with `status: "success"` and the
kind-specific payload. The `source` field is always the tagged-union from
`source.ts`:

```json
{
  "status": "success",
  "source": { "kind": "modrinth", "slug": "worldedit", "version": "*" },
  "kind": "modrinth",
  "slug": "worldedit",
  "title": "WorldEdit",
  "description": "...",
  "homepage": "...",
  "license": "GPL-3.0-or-later",
  "modrinth_url": "https://modrinth.com/plugin/worldedit",
  "versions": [
    {
      "id": "abc123",
      "version": "7.3.15",
      "date": "2025-08-04T10:15:00Z",
      "type": "release",
      "game_versions": ["1.21.8", "1.21.7"],
      "compatibility": "ok"
    }
  ]
}
```

## Error cases

| Trigger               | Message                                                                   |
| --------------------- | ------------------------------------------------------------------------- |
| Unknown Modrinth slug | `Modrinth: project "<slug>" not found (<url>)`                            |
| Modrinth 5xx          | `Modrinth API request failed for "<slug>": <status> <statusText> (<url>)` |
| Missing file          | `file not found: <abs> (from identifier "<raw>")`                         |
| Unknown workspace     | `workspace not found: "<name>". known workspaces: ...`                    |

## See also

- [`pluggy search`](./search.md): keyword search on Modrinth.
- [`pluggy list --outdated`](./list.md#--outdated): compare the lockfile against Modrinth's latest.
