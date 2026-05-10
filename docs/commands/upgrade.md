# `pluggy upgrade`

Replace the running pluggy binary with the latest GitHub release.

## Usage

```text
pluggy upgrade [options]
```

## Flags

| Flag           | Default | Notes                                                            |
| -------------- | ------- | ---------------------------------------------------------------- |
| `--print-only` | off     | Skip the download and print manual install instructions instead. |

## What it does

1. Queries `https://api.github.com/repos/pluggy-sh/pluggy/releases/latest`.
2. Maps `process.platform` × `process.arch` to a release asset name:

   | Platform | Arch    | Asset                      |
   | -------- | ------- | -------------------------- |
   | `darwin` | `arm64` | `pluggy-darwin-arm64`      |
   | `darwin` | `x64`   | `pluggy-darwin-amd64`      |
   | `linux`  | `arm64` | `pluggy-linux-arm64`       |
   | `linux`  | `x64`   | `pluggy-linux-amd64`       |
   | `win32`  | `x64`   | `pluggy-windows-amd64.exe` |

3. Downloads the asset to `<tmp>/pluggy-upgrade-<rand>/pluggy-new` and
   `chmod +x` on POSIX.
4. Renames the current binary to `<current>.old`, then renames the staged
   new binary into place. On Windows this works because Node's `rename`
   will swap an open executable.
5. If the second rename fails, the `.old` backup is restored atomically.

Without an asset mapped for your platform, pluggy prints the manual
install instructions and exits clean.

## Human output

```text
$ pluggy upgrade
Upgrading to: v0.2.0
downloading https://github.com/pluggy-sh/pluggy/releases/download/v0.2.0/pluggy-darwin-arm64
✓ pluggy v0.2.0 installed at ~/.pluggy/bin/pluggy (previous binary backed up to ~/.pluggy/bin/pluggy.old)
```

With `--print-only`:

```text
Latest release: v0.2.0
Published:      2026-03-01T12:00:00Z
URL:            https://github.com/pluggy-sh/pluggy/releases/tag/v0.2.0

Install manually:

  Unix:    curl -fsSL https://pluggy.sh/install.sh | sh
  Windows: irm https://pluggy.sh/install.ps1 | iex
```

## Permissions

pluggy uses the path Node reports as `process.execPath`. The install
scripts drop the binary somewhere writable by the current user, so no
`sudo` is needed for upgrades:

- macOS/Linux: `~/.pluggy/bin/pluggy` (override with `PLUGGY_HOME`).
- Windows: `%LOCALAPPDATA%\Programs\pluggy\pluggy.exe`.

If pluggy is currently installed in a system-owned path (for example a
legacy `/usr/local/bin/pluggy` install), `pluggy upgrade` detects this
and prints recovery instructions: either re-run with `sudo`, or
reinstall via the install script (which will land in `~/.pluggy/bin`)
and remove the old system binary so it doesn't shadow the new one.

## Update notification

When pluggy starts, it reads a small state file (`<state>/update-check.json`, in the [state directory](../glossary.md#state-directory) so `pluggy cache clean` doesn't reset it) and, at most once per 24 hours, fetches the latest release tag in the background. If the cache shows that you are out of date, you'll see a one-line notice on stderr after the command finishes:

```text
✦ pluggy 0.3.0 available, you have 0.2.0. Run pluggy upgrade.
```

The notice is suppressed when:

- `--json` is set on the current command.
- `CI` is set to a non-empty truthy value.
- stderr isn't a TTY (for example piped output).
- `PLUGGY_NO_UPDATE_CHECK=1` is set in the environment.
- The running build is the dev sentinel (`0.0.0`).

Run `pluggy doctor` to see the same information inline.

## Error cases

| Trigger               | Message                                                                      |
| --------------------- | ---------------------------------------------------------------------------- |
| GitHub API error      | `Failed to fetch latest release: <status> <statusText>`                      |
| GitHub rate-limit     | `GitHub API error: API rate limit exceeded ...`                              |
| Asset download fails  | `failed to download <url>: <status> <statusText>`                            |
| Empty asset           | `downloaded asset from <url> is empty`                                       |
| Rename-in-place fails | `failed to install new binary at <path>; restored previous version: <errno>` |

## See also

- [Cross-platform notes](../cross-platform.md): where the binary lives on each OS.
