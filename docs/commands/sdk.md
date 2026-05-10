# `pluggy sdk`

Manage the JDKs pluggy provisions for `build`, `test`, and `dev`. You rarely run these commands directly: `pluggy build` auto-installs the right JDK on first use. Reach for `pluggy sdk` to pre-warm the cache, pin a distribution per project, or remove a slot.

For cross-cutting cache housekeeping (eviction across all categories, total size, cleaning everything) see [`pluggy cache`](./cache.md).

## Background

pluggy resolves a project's required Java major from `compatibility.versions[0]` and provisions a matching [JDK](../glossary.md#jdk) from the [Foojay Disco API](https://api.foojay.io/disco/v3.0/distributions). Cached slots live under `<cachePath>/jdk/<distribution>-<major>-<os>-<arch>/`. The system `JAVA_HOME` takes precedence when its major matches what the project needs, so existing toolchains (asdf, mise, hand-installed JDKs) keep working.

Set `PLUGGY_NO_AUTO_INSTALL=1` to make a cache miss raise instead of downloading. Use this in CI if you want to fail loudly when the cache hasn't been pre-warmed.

## Subcommands

Every subcommand supports the global `--json` flag for structured output.

| Subcommand                     | Purpose                                                  |
| ------------------------------ | -------------------------------------------------------- |
| `pluggy sdk install [<major>]` | Download and cache a JDK.                                |
| `pluggy sdk list`              | Show cached JDKs, with their full versions and last use. |
| `pluggy sdk list --available`  | Show distributions pluggy can install.                   |
| `pluggy sdk path <major>`      | Print `JAVA_HOME` for a cached JDK.                      |
| `pluggy sdk use <major>`       | Pin a JDK in `project.json`.                             |
| `pluggy sdk remove <major>`    | Delete a cached JDK.                                     |

## `install`

Download a JDK and cache it. With no `<major>`, pluggy derives the major from the current project's `compatibility.versions[0]`.

```text
$ pluggy sdk install 21
sdk: downloading temurin 21.0.5+11 (~190 MB)…
sdk: extracting JDK…
✓ sdk: installed temurin 21 at /Users/you/Library/Caches/pluggy/jdk/temurin-21-macos-aarch64/Contents/Home
```

Pass `--distribution <name>` to install a non-default distribution. Pass `--force` to wipe the slot and re-download.

The allowlist is `temurin` (default), `zulu`, `liberica`, `corretto`, `microsoft`, and `graalvm_community`. Run `pluggy sdk list --available` to see the current set.

## `list`

Show the cached JDKs.

```text
$ pluggy sdk list
Cached JDKs:
  ✓ temurin 21  (21.0.11+10)  last used just now
  ✓ zulu 17     (17.0.13)     last used 3d ago
```

A red `✗` means the manifest still references the slot but the directory is gone. `pluggy cache prune --category jdk` cleans those up.

`pluggy sdk list --available` switches to the install allowlist.

## `path`

Print the absolute `JAVA_HOME` for a cached JDK. Exits `1` when the JDK is not installed. Useful for IDE integrations and scripts.

```text
$ pluggy sdk path 21
/Users/you/Library/Caches/pluggy/jdk/temurin-21-macos-aarch64/Contents/Home

$ export JAVA_HOME=$(pluggy sdk path 21)
```

Pass `--distribution <name>` to disambiguate when multiple distributions of the same major are installed.

## `use`

Pin a JDK in the current `project.json` so teammates land on the same one.

```text
$ pluggy sdk use 21 --distribution zulu
✓ Pinned Java 21 (zulu) in /Users/you/my-plugin/project.json
```

The pin is written under the `jdk` block:

```json
"jdk": {
  "major": 21,
  "distribution": "zulu"
}
```

See [`jdk` in the `project.json` reference](../project-json.md#jdk-optional) for the full field shape. The pin overrides the auto-derived major from `compatibility.versions[0]`.

## `remove`

Delete a cached JDK.

```text
$ pluggy sdk remove 17 --distribution zulu
✓ Removed zulu 17
```

`remove` always honors the `--distribution` value, so you can prune one distribution while keeping another.

## CI escape hatch

CI workflows that don't want pluggy reaching the network mid-build should pre-warm the cache and set `PLUGGY_NO_AUTO_INSTALL=1`:

```yaml
- run: pluggy sdk install
- run: pluggy build
  env:
    PLUGGY_NO_AUTO_INSTALL: "1"
```

The first command resolves the major from `project.json` and downloads the JDK. The second builds against the cached slot and fails fast if anything is missing.

## See also

- [`jdk` in the `project.json` reference](../project-json.md#jdk-optional): the per-project pin.
- [`pluggy cache`](./cache.md): cross-category cache housekeeping (`info`, `prune`, `clean`).
- [`pluggy doctor`](./doctor.md): the `Project JDK` check reports cache state.
- [Foojay Disco distributions](https://api.foojay.io/disco/v3.0/distributions): every distribution Disco knows about.
