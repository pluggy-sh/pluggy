# `pluggy cache`

Inspect and manage everything pluggy keeps under its on-disk cache: cached JDKs, platform server jars, BuildTools artifacts, dependency jars, the JetBrains Runtime used for hotswap, and the HotswapAgent. Use this when disk fills up, when you want to reset to a known-clean state, or when you want to script the cache path into shell automation.

For installing or removing a _specific_ JDK toolchain, see [`pluggy sdk`](./sdk.md).

## Background

The cache root is OS-specific:

| OS      | Path                                                     |
| ------- | -------------------------------------------------------- |
| macOS   | `~/Library/Caches/pluggy`                                |
| Windows | `%LOCALAPPDATA%\pluggy\cache`                            |
| Linux   | `$XDG_CACHE_HOME/pluggy` (defaults to `~/.cache/pluggy`) |

Everything under this directory is reproducible: deleting it forces re-downloads but never loses irreplaceable state. Persistent metadata (e.g. the cached "latest pluggy release" timestamp) lives under a separate state directory and survives `pluggy cache clean`.

Categories pluggy tracks:

| Category       | What it holds                                                              |
| -------------- | -------------------------------------------------------------------------- |
| `jdk`          | Cached JDKs (extracted slots + downloaded archives), with an LRU manifest. |
| `versions`     | Platform server jars (Paper, Velocity, Waterfall, Folia, Travertine, …).   |
| `buildtools`   | `BuildTools.jar` plus its CraftBukkit/Spigot output cache.                 |
| `dependencies` | Resolved plugin dependencies — `maven`, `modrinth`, and `file` subkinds.   |
| `jbr`          | JetBrains Runtime used by `pluggy dev` for hotswap.                        |
| `hotswap`      | HotswapAgent jars used by `pluggy dev`.                                    |

## Subcommands

Every subcommand supports the global `--json` flag for structured output.

| Subcommand                           | Purpose                                                   |
| ------------------------------------ | --------------------------------------------------------- |
| `pluggy cache` / `pluggy cache info` | Show entries and bytes per category. The default action.  |
| `pluggy cache list [--category]`     | Per-entry listing, newest first.                          |
| `pluggy cache path`                  | Print the cache root. Scriptable.                         |
| `pluggy cache clean [--category]`    | Wipe a category — or, with no flag, the entire cache.     |
| `pluggy cache prune [...]`           | LRU-evict by age and size budget. Safe one-shot defaults. |

## `info`

Default action — running `pluggy cache` with no subcommand is identical.

```text
$ pluggy cache
cache /Users/you/Library/Caches/pluggy

  jdk             2.00 GB  4 entries
  versions        4.50 GB  12 entries
  buildtools    580.00 MB  3 entries
  dependencies  312.00 MB  87 entries
    └ maven       280.00 MB  60 entries
    └ modrinth     30.00 MB  25 entries
    └ file          2.00 MB  2 entries
  jbr           450.00 MB  1 entry
  hotswap         1.40 MB  1 entry

  total  7.34 GB
```

## `list`

List individual entries, newest first within each category.

```text
$ pluggy cache list --category versions
versions
  paper-1.21.1-127.jar  450.00 MB  (2h ago)
  velocity-3.4.0-489.jar  41.00 MB  (3d ago)
```

`--category` accepts `jdk`, `versions`, `buildtools`, `dependencies`, `jbr`, or `hotswap`. Omit it to list every category at once. With `--json`, the output is `{ status, category, groups: [{ category, entries: [...] }] }`.

## `path`

Print the cache directory. Useful in shell scripts:

```text
$ pluggy cache path
/Users/you/Library/Caches/pluggy

$ du -sh "$(pluggy cache path)"
7.3G    /Users/you/Library/Caches/pluggy
```

## `clean`

Delete cache entries. With no flag, wipes everything pluggy manages under the cache root. With `--category`, scopes the wipe.

```text
$ pluggy cache clean --category versions
? Delete the "versions" category (4.50 GB)? Yes
✔ Removed 12 entries (4.50 GB).
```

`clean` is interactive by default. Pass `-y`/`--yes` to skip the confirmation; `--json` skips it implicitly. JDK manifest entries are reconciled automatically so subsequent `cache info` calls don't show ghost numbers.

## `prune`

Budget-driven eviction. Safe to run in a one-shot — defaults are conservative.

```text
$ pluggy cache prune
  - versions/paper-1.20.4-450.jar (age, 450.00 MB)
  - dependencies/net.kyori:adventure-api:4.18.0 (age, 280.00 KB)
✔ Evicted 2; kept 102. Freed 450.27 MB.
```

| Flag                   | Default | Effect                                                                                                                               |
| ---------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `--max-age <duration>` | `90d`   | Drop entries older than this. Accepts `s`, `m`, `h`, `d`, `w` suffixes (`90d`, `12h`, `1w`). Use `0` to disable age-based pruning.   |
| `--max-size <size>`    | (none)  | After age pruning, evict oldest-first until the scoped total is at or below this budget. Accepts `K`, `M`, `G`, `T` suffixes (`5G`). |
| `--keep-latest <n>`    | `2`     | JDK only: keep the N most-recently-used JDKs per major regardless of age. Set to `0` to opt out.                                     |
| `--category <name>`    | (all)   | Limit pruning to one category.                                                                                                       |
| `--dry-run`            | (off)   | Print what would be removed without touching disk.                                                                                   |

For JDKs, "last used" is sourced from the LRU manifest (`ensureJdk` bumps it on every cache hit). For every other category, "last used" is the file's mtime — which is set when the entry was last downloaded.

### Combined budgets

`pluggy cache prune --max-age 30d --max-size 2G` first removes anything not touched in 30 days, then evicts more (oldest first) until the total drops to 2 GB. `--keep-latest` is JDK-specific and applies before either.

## CI usage

In CI you usually want strict, predictable cache behavior. Two patterns:

```yaml
# Free space mid-pipeline without losing the JDK you just used
- run: pluggy cache prune --category versions --max-age 0 --max-size 1G
```

```yaml
# Wipe everything between matrix rows
- run: pluggy cache clean --yes
```

## See also

- [`pluggy sdk`](./sdk.md) — install, list, pin, and remove specific JDK toolchains.
- [`pluggy doctor`](./doctor.md) — the `Cache reachability` check reports cache root + total size.
