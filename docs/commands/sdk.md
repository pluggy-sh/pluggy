# `pluggy sdk`

Manage the JDKs pluggy provisions for `build`, `test`, and `dev`. You rarely run these commands directly: `pluggy build` auto-installs the right JDK on first use. Reach for `pluggy sdk` to pre-warm the cache, pin a distribution per project, or remove a slot.

For cross-cutting cache housekeeping (eviction across all categories, total size, cleaning everything) see [`pluggy cache`](./cache.md).

## Background

pluggy resolves a project's required Java major from `compatibility.versions[0]` and provisions a matching [JDK](../glossary.md#jdk) from the [Foojay Disco API](https://api.foojay.io/disco/v3.0/distributions). Cached slots live under `<cachePath>/jdk/<distribution>-<major>-<os>-<arch>/`. The system `JAVA_HOME` takes precedence when its major matches what the project needs, so existing toolchains (asdf, mise, hand-installed JDKs) keep working.

Set `PLUGGY_NO_AUTO_INSTALL=1` to make a cache miss raise instead of downloading. Use this in CI if you want to fail loudly when the cache hasn't been pre-warmed.

## Subcommands

Every subcommand supports the global `--json` flag for structured output.

| Subcommand                         | Purpose                                                   |
| ---------------------------------- | --------------------------------------------------------- |
| `pluggy sdk info [<distribution>]` | Show what's installable here, and what this project uses. |
| `pluggy sdk install [<coord>]`     | Download and cache a JDK.                                 |
| `pluggy sdk list`                  | Show cached JDKs, with their full versions and last use.  |
| `pluggy sdk path <coord>`          | Print `JAVA_HOME` for a cached JDK.                       |
| `pluggy sdk use <coord>`           | Pin a JDK in `project.json`.                              |
| `pluggy sdk remove <coord>`        | Delete a cached JDK.                                      |

Bare `pluggy sdk` runs `sdk list`.

## Coordinates

Every subcommand that names a JDK takes a coordinate: either a bare major, or
`<distribution>@<major>`. This is the same `<name>@<version>` shape
[`pluggy install`](./install.md) uses for dependencies.

```text
pluggy sdk install 21              # default distribution (temurin)
pluggy sdk install temurin@21      # explicit
pluggy sdk use zulu@17
pluggy sdk remove zulu@17
```

## `info`

Answers "what can I install, and what is this project going to use?" Availability
is queried per host, so a major published for Linux but not for your OS and
architecture does not appear.

```text
$ pluggy sdk info
Distributions installable on macos/aarch64
  temurin            26, 25, 24, 23, 22, 21, 20, 19, 18, 17, 11 (default)
  zulu               26, 25, 24, 23, 22, 21, 20, 19, 18, 17, 16, 15, 13, 11, 8
  liberica           26, 25, 24, 23, 22, 21, 20, 19, 18, 17, 11, 8
  corretto           26, 25, 24, 23, 22, 21, 20, 19, 18, 17, 11, 8
  microsoft          25, 21, 17, 16, 11
  graalvm_community  25, 24, 23, 22, 21, 20, 17

This project uses temurin 25 — required by the Minecraft version's build manifest.
Pin a different one: pluggy sdk use <distribution>@<major>
```

Pass a distribution for its full versions and cache state:

```text
$ pluggy sdk info temurin
temurin
  available for macos/aarch64:  26.0.1+8, 25.0.3+9, 24.0.2+12, 21.0.11+10, …
  cached:                       21.0.11+10, 25.0.3+9
  used by this project:         25

Install: pluggy sdk install temurin@26
```

The trailing sentence names _why_ the project resolved to that major: a `jdk`
pin in `project.json`, the Minecraft version's build manifest, pluggy's version
table, or the default.

## `install`

Download a JDK and cache it. With no `<major>`, pluggy derives the major from the current project's `compatibility.versions[0]`.

```text
$ pluggy sdk install 21
sdk: downloading temurin 21.0.5+11 (~190 MB)…
sdk: extracting JDK…
✓ sdk: installed temurin 21 at /Users/you/Library/Caches/pluggy/jdk/temurin-21-macos-aarch64/Contents/Home
```

Pass a `<distribution>@<major>` coordinate for a non-default distribution. Pass `--force` to reinstall; the replacement is downloaded and verified before the existing JDK is removed, so a failed download never leaves you without one.

The allowlist is `temurin` (default), `zulu`, `liberica`, `corretto`, `microsoft`, and `graalvm_community`. Run `pluggy sdk info` to see which majors each one publishes for your machine.

## `list`

Show the cached JDKs.

```text
$ pluggy sdk list
Cached JDKs:
  ✓ temurin 21  (21.0.11+10)  334.50 MB  last used just now
  ✓ zulu 17     (17.0.13)     301.20 MB  last used 3d ago

stored under /Users/you/Library/Caches/pluggy/jdk — manage with `pluggy cache`
```

A red `✗` means the manifest still references the slot but the directory is gone. `pluggy cache prune --category jdk` cleans those up.

For what you _could_ install rather than what you have, use [`sdk info`](#info).

## `path`

Print the absolute `JAVA_HOME` for a cached JDK. Exits `1` when the JDK is not installed. Useful for IDE integrations and scripts.

```text
$ pluggy sdk path 21
/Users/you/Library/Caches/pluggy/jdk/temurin-21-macos-aarch64/Contents/Home

$ export JAVA_HOME=$(pluggy sdk path 21)
```

Use a `<distribution>@<major>` coordinate to disambiguate when multiple distributions of the same major are installed.

## `use`

Pin a JDK in the current `project.json` so teammates land on the same one.

```text
$ pluggy sdk use zulu@21
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
$ pluggy sdk remove zulu@17
✓ Removed zulu 17 (freed 301.20 MB) from /Users/you/Library/Caches/pluggy/jdk/zulu-17-macos-aarch64
```

The coordinate selects the slot, so you can prune one distribution while keeping another.

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
