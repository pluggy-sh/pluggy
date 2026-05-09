# Dependencies

Four source kinds; one grammar; one lockfile.

## Source kinds

| Scheme    | CLI form                                 | project.json `source`          | Resolver                                           |
| --------- | ---------------------------------------- | ------------------------------ | -------------------------------------------------- |
| Modrinth  | `<slug>[@<version>]`                     | `modrinth:<slug>`              | Fetches from `api.modrinth.com/v2`.                |
| Maven     | `maven:<groupId>:<artifactId>@<version>` | `maven:<groupId>:<artifactId>` | Walks `registries` in order.                       |
| File      | `<path>.jar`                             | `file:<path>`                  | Reads the local jar, content-addressed by SHA-256. |
| Workspace | `workspace:<name>`                       | `workspace:<name>`             | Points at a sibling's built jar.                   |

## The CLI identifier grammar

`pluggy install <identifier>` accepts the four forms below. Missing version
segments resolve to `"*"` (latest stable) during resolve; the resolver
concretizes before it writes the lockfile.

### Modrinth

```text
pluggy install worldedit
pluggy install worldedit@7.3.15
```

Slug rules: `^[a-z0-9][a-z0-9-_]*$`. A trailing `@<version>` must be a
non-empty Modrinth version number (not a semver range).

Absent version → latest stable, unless `--beta` is set, in which case the
newest pre-release wins too.

Specifying a beta/alpha version without `--beta` fails fast:

```text
error: Modrinth: version "1.2.3-beta" of "myslug" is a beta release; pass --beta to install pre-releases
```

### Maven

```text
pluggy install maven:net.kyori:adventure-api@4.17.0
```

`groupId` and `artifactId` both match `^[a-zA-Z][\w.-]*$`. The version
after `@` is mandatory on the CLI: there's no "latest" equivalent for
Maven, because pluggy doesn't index Maven registries.

### File

```text
pluggy install ./libs/my-lib.jar
```

Anything ending in `.jar` (case-insensitive) is treated as a file source.
Relative paths resolve against the repo root, not the current working
directory.

### Workspace

```text
pluggy install workspace:api
```

Names the sibling in `<root>/project.json:workspaces`. Valid only inside a
pluggy project; `info workspace:api` from outside a project errors.

A `workspace:` identifier does not accept a version: the sibling's own
`project.json:version` is authoritative.

## The project.json form

The CLI sugar expands to long-form source strings in `project.json`:

```json
"dependencies": {
  "worldedit":    { "source": "modrinth:worldedit",               "version": "7.3.15" },
  "adventure-api":{ "source": "maven:net.kyori:adventure-api",    "version": "4.17.0" },
  "my-lib":       { "source": "file:./libs/my-lib.jar",           "version": "1.0.0" },
  "api":          { "source": "workspace:api",                    "version": "*" }
}
```

Modrinth deps have a shorthand: `"worldedit": "7.3.15"` is equivalent to
the long form with `source: "modrinth:worldedit"`. Every other kind must
use the long form.

The dependency key is the name `list`, `shading`, and the lockfile use.
`install` picks it automatically: slug for Modrinth, `artifactId` for
Maven, basename-without-`.jar` for files, workspace name for workspaces.

## Registries

Maven Central (`https://repo1.maven.org/maven2/`) is appended automatically,
so a Maven dependency that lives there needs no `registries` entry at all.
Declare extra registries when you depend on artifacts that Central doesn't
host (PaperMC, Spigot snapshots, GitHub Packages, …). Modrinth is implicit
too: no registry declaration is required.

```json
"registries": [
  "https://repo.papermc.io/repository/maven-public/"
]
```

### Aliases

A short scheme expands to a full URL so common registries are easy to
declare:

| Alias               | Expands to                                |
| ------------------- | ----------------------------------------- |
| `github:owner/repo` | `https://maven.pkg.github.com/owner/repo` |

Aliases work in both string and object form; credentials stay attached:

```json
"registries": [
  "github:my-org/public-libs",
  {
    "url": "github:my-org/private",
    "credentials": {
      "username": "ci-bot",
      "password": "${GITHUB_TOKEN}"
    }
  }
]
```

Registry URLs are tried in declaration order, then `DEFAULT_MAVEN_REGISTRIES`
(Maven Central). The platform's own Maven repository (such as PaperMC for
Paper's `paper-api`) is prepended automatically during a build, you don't
need to list it in `registries`.

## Lockfile

`pluggy.lock` lives at the repo root. It's written by `install`, read by
`install --force` / `build` / `list` / `doctor`, and shared across every
workspace in a monorepo.

```json
{
  "version": 1,
  "entries": {
    "adventure-api": {
      "source": {
        "kind": "maven",
        "groupId": "net.kyori",
        "artifactId": "adventure-api",
        "version": "4.17.0"
      },
      "resolvedVersion": "4.17.0",
      "integrity": "sha256-a3b1...",
      "declaredBy": ["my_plugin"],
      "transitives": [
        {
          "source": {
            "kind": "maven",
            "groupId": "net.kyori",
            "artifactId": "adventure-key",
            "version": "4.17.0"
          },
          "resolvedVersion": "4.17.0",
          "integrity": "sha256-e2f4..."
        }
      ]
    }
  }
}
```

Every top-level entry carries:

| Field             | Meaning                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------ |
| `source`          | The full tagged union from `source.ts`: kind + identifying fields + version.               |
| `resolvedVersion` | Concrete version resolved by `install`. Never a range, never `"*"`.                        |
| `integrity`       | `sha256-<hex>` of the resolved jar bytes. Verified on every consuming read.                |
| `declaredBy`      | Workspaces that declared this dep. Used by `remove` to know when the entry can be dropped. |
| `transitives`     | Optional. Recursive. Omitted when the closure is empty. Does not include `declaredBy`.     |

Transitives are recorded inline: each child carries its own grandchildren.
The field is elided entirely when the closure is empty; writers must not
emit an empty array.

The file is atomic-written: pluggy creates a `.<pid>.<rand>.tmp` sibling,
`fsync`s, then `rename`s over the target. Entries are sorted by key so
diffs are deterministic. Trailing LF.

### When pluggy rewrites it

- `pluggy install`: on a single-identifier run, adds or updates that one
  entry; on a bare `install`, resolves anything stale and prunes orphans.
- `pluggy install --force`: re-resolves everything even if the lockfile
  is fresh.
- `pluggy remove`: drops an entry when no workspace still declares it
  (shrinks `declaredBy` otherwise).

`build` and `dev` do not write `pluggy.lock`. They resolve against the
live `project.json` (using the cache where possible) and expect `install`
to have produced the lockfile. A missing lockfile is not an error for a
build (pluggy will resolve on the fly), but your builds stop being
reproducible.

### Drift detection

`install` (without `--force`) compares every declared dep's `(source,
version)` pair against the lockfile. Entries that don't match, or that
aren't in the lockfile at all, are added to the "drift" set and
re-resolved. Everything else is skipped.

Orphan entries in the lockfile (locked but no longer declared) are deleted
when `install` runs without a specific plugin argument. A targeted
`install <plugin>` never prunes; it only updates the one entry.

## SNAPSHOT semantics

Maven versions ending in `-SNAPSHOT` require a metadata lookup: published
artifacts are stored under timestamped filenames, not the declared version.
pluggy fetches `<base>/<group>/<artifact>/<version>/maven-metadata.xml`,
reads the `<snapshotVersion>` for extension `jar` (and `pom` for the
transitives query), and constructs the real download URL.

Behaviour:

- `1.0.0-SNAPSHOT`: resolved on every `install`; the cached jar path stays
  `<cache>/dependencies/maven/<group>/<artifact>/1.0.0-SNAPSHOT.jar`, and
  the file is rewritten when a new timestamped publish appears.
- `1.0.0` (release): resolved once, cached forever.

Plain SNAPSHOT versions are transparent to users. You write
`"version": "1.0.0-SNAPSHOT"` in `project.json` and pluggy does the rest.

## Maven transitive resolution

Every Maven artifact's POM is fetched and parsed. pluggy understands:

- Direct `<dependencies>` entries with scope `compile`, `runtime`, or unset.
- `<dependencyManagement>` BOM imports (`<type>pom</type>` +
  `<scope>import</scope>`).
- Lower-bounded ranges like `[1.0,2.0)`: pluggy picks the lower bound.

It does not implement:

- Property expansion (`${some.property}`).
- Parent POM inheritance.
- Real range resolution (picking the highest in-range available version).

Transitives with `<optional>true</optional>`, `test`/`provided`/`system`
scope, or non-jar types are skipped. Anything with an unresolved `${...}`
placeholder is logged at `--verbose` and skipped.

The closure depth is capped at 8 levels.

In practice this is enough for Bukkit / Paper / Velocity plugin
development: the API jars and mainstream libraries (Kyori Adventure,
Caffeine, etc.) resolve cleanly. If you hit a POM that needs property
expansion, declare the missing transitives explicitly in `project.json`.

## Caches

pluggy never redownloads a jar it already has locally. The cache lives at:

- macOS: `~/Library/Caches/pluggy/`
- Linux: `$XDG_CACHE_HOME/pluggy/` (defaulting to `~/.cache/pluggy/`)
- Windows: `%LOCALAPPDATA%\pluggy\cache\`

Layout:

```text
dependencies/
  modrinth/<slug>/<version>.jar
  maven/<groupId>/<artifactId>/<version>.jar
  file/<sha256-hex>.jar
versions/
  paper-<version>-<build>.jar
  velocity-<version>-<build>.jar
  spigot-<version>-<build>.jar
BuildTools.jar          (spigot/bukkit)
BuildTools/             (per-version BuildTools working directory)
```

`workspace:` deps are not cached: the resolver points at the sibling's
`<workspace>/bin/<name>-<version>.jar`, and the build pipeline is
responsible for producing that file.

Cache size is surfaced by `pluggy doctor`. Wipe with `rm -rf` at the path
above; pluggy reconstructs everything on the next run.

## See also

- [`pluggy install`](./commands/install.md): the CLI flags.
- [Build pipeline](./build-pipeline.md): how resolved deps hit the classpath.
- [Workspaces](./workspaces.md): the `workspace:` kind in detail.
