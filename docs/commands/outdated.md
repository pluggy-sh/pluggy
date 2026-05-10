# `pluggy outdated`

Show locked dependencies that have a newer version available upstream. Walks every entry in `pluggy.lock`, asks Modrinth or Maven Central (and your declared registries) for the latest, and renders a table of stale entries grouped by top-level vs transitive.

## Usage

```text
pluggy outdated [options]
```

## Flags

| Flag     | Default | Notes                                             |
| -------- | ------- | ------------------------------------------------- |
| `--beta` | off     | Include pre-release versions when finding latest. |

`--json` works as a global flag.

## What it queries

For each locked entry, pluggy fetches the latest version per source kind:

- **Modrinth**: `GET /v2/project/<slug>/version`, picks the newest stable (or pre-release with `--beta`).
- **Maven**: walks your declared registries plus Maven Central, reads each `maven-metadata.xml`, picks the highest version that is not a SNAPSHOT.
- **File** and **workspace**: not queried. Reported as `unknown` because there's no upstream notion of "latest".

Each row is classified by comparing the locked version to the latest:

- `major`: the major version went up (highlighted yellow).
- `minor`: the minor version went up.
- `patch`: only the patch went up.
- `same`: locked version is at or above latest.
- `unknown`: source has no notion of latest, or the latest couldn't be parsed.
- `error`: lookup failed (network, registry rejected the query).

## Human output

When everything is current:

```text
$ pluggy outdated
✓ All 6 dependencies up to date
```

With stale entries:

```text
$ pluggy outdated

Outdated
  Name                       Current  Latest  Source
  adventure-api              4.17.0   5.0.1   maven
  net.kyori:adventure-key    4.17.0   5.0.1   maven (transitive)
  org.jetbrains:annotations  22.0.0   26.1.0  maven (transitive)

1 top-level outdated, 3 entries total stale.
```

Top-level deps appear with just their source kind. Transitives appear with `(transitive)` after the kind. `latest` is yellow when the change is a major bump.

Errored lookups are reported as warnings under the table:

```text
! org.example:flaky: HTTP 503 from registry
```

## JSON output

```json
{
  "status": "success",
  "outdatedCount": 1,
  "rows": [
    {
      "name": "adventure-api",
      "source": "maven",
      "current": "4.17.0",
      "latest": "5.0.1",
      "diff": "major",
      "topLevel": true
    },
    {
      "name": "net.kyori:adventure-key",
      "source": "maven",
      "current": "4.17.0",
      "latest": "5.0.1",
      "diff": "major",
      "topLevel": false
    }
  ]
}
```

`outdatedCount` counts only top-level rows whose `diff` is `major`, `minor`, or `patch`. Network failures on individual rows surface as `diff: "error"` plus an `error` field, never as a fatal exit. Run with `--beta` to include pre-release versions in `latest`.

## Error cases

| Trigger           | Code                     | Message                                                              |
| ----------------- | ------------------------ | -------------------------------------------------------------------- |
| Outside a project | `E_OUTDATED_NO_PROJECT`  | `No pluggy project found. Run this from inside a project directory.` |
| No lockfile       | `E_OUTDATED_NO_LOCKFILE` | `No pluggy.lock found. Run pluggy install first.`                    |

Per-entry network failures do not fail the command. They appear in the output as `error` rows.

## Updating after `outdated`

`outdated` is read-only. To actually update a top-level dep, run `pluggy install <name>@<latest>` for Modrinth, or `pluggy install maven:<g>:<a>@<latest>` for Maven. Transitives update through their parent: bump the parent and re-resolve.

## See also

- [`pluggy install`](./install.md): pin a new version of a dep.
- [`pluggy why`](./why.md): trace which top-level dep is keeping a transitive locked.
- [`pluggy doctor`](./doctor.md): the `Outdated dependencies` check uses the same machinery.
