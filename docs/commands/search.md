# `pluggy search`

Search Modrinth by keyword, optionally filtered by platform and Minecraft version.

## Usage

```text
pluggy search [options] <query>
```

`<query>` is a non-empty string. Modrinth treats it as a free-form search term.

## Flags

| Flag                 | Default | Notes                                            |
| -------------------- | ------- | ------------------------------------------------ |
| `--size <n>`         | `10`    | Page size.                                       |
| `--page <n>`         | `0`     | Zero-indexed page offset.                        |
| `--platform <id>`    | none    | Filter by platform tag (`paper`, `spigot`, ...). |
| `--version <semver>` | none    | Filter by Minecraft version.                     |

## How it queries

pluggy hits `GET /v2/search` with facets:

```text
[["project_type:plugin"], ["categories:<platform>"], ["versions:<mcVersion>"]]
```

The first facet is always present, since the search is scoped to plugins. The other two appear only when you pass the corresponding flag.

Results are served back in Modrinth's native order (relevance + downloads).

## Human output

```text
page 0 • 3 of 247 results

EssentialsX  (essentialsx)
  The essential plugin suite for Minecraft servers
  MC: 1.8.8 … 1.21.8
  downloads: 12,400,000
  https://modrinth.com/plugin/essentialsx

LuckPerms  (luckperms)
  A permissions plugin for Minecraft servers
  MC: 1.8.8 … 1.21.8
  downloads: 9,800,000
  https://modrinth.com/plugin/luckperms

  ...
```

Game-version ranges are compacted to a `<lowest> ... <highest>` span when the plugin supports more than one. Single-version plugins show that one version verbatim. Plugins without version data omit the line.

## JSON output

```json
{
  "status": "success",
  "hits": [
    {
      "slug": "essentialsx",
      "title": "EssentialsX",
      "description": "...",
      "categories": ["paper", "spigot"],
      "project_type": "mod",
      "downloads": 12400000,
      "follows": 2210,
      "icon_url": "https://cdn.modrinth.com/...",
      "project_id": "ojYkJWBP",
      "author": "drtshock",
      "versions": ["1.8.8", "...", "1.21.8"],
      "latest_version": "3fCrQEgE"
    }
  ],
  "page": 0,
  "size": 10,
  "total": 247
}
```

`project_type` is always `"mod"` in Modrinth's schema, because plugins are a category within the `mod` type. Don't read too much into it.

`latest_version` is an opaque Modrinth version id, not a semver. Use [`pluggy info <slug>`](./info.md) to get the human version numbers.

## Error cases

| Trigger            | Message                                                               |
| ------------------ | --------------------------------------------------------------------- |
| Empty query        | `search query must be a non-empty string (got "")`                    |
| Modrinth non-2xx   | `Modrinth search failed for "<query>": <status> <statusText> (<url>)` |
| Malformed response | `Modrinth search returned malformed response for "<query>" (<url>)`   |

## See also

- [`pluggy info`](./info.md): full metadata for one slug.
- [`pluggy install`](./install.md): add a search hit to your project.
