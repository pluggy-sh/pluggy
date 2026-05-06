# Cross-platform notes

pluggy ships as a single native binary per (OS, arch). Behaviour is
identical across macOS, Linux, and Windows — when it isn't, that's a
bug. This page documents the platform-specific choices that are visible
to you: where things live, how paths and line endings are handled, and
how signals flow.

## Binary

The release pipeline (`bun build --compile`) produces these assets per
tag:

| Asset                      | Platform | Arch          |
| -------------------------- | -------- | ------------- |
| `pluggy-darwin-arm64`      | macOS    | Apple Silicon |
| `pluggy-darwin-amd64`      | macOS    | Intel         |
| `pluggy-linux-arm64`       | Linux    | aarch64       |
| `pluggy-linux-amd64`       | Linux    | x86_64        |
| `pluggy-windows-amd64.exe` | Windows  | x86_64        |

No Windows ARM, no FreeBSD. `pluggy upgrade` detects your platform and
downloads the right asset; unsupported combinations fall back to
printing install instructions.

## Install paths

| OS      | Path                                        | Writable by user? |
| ------- | ------------------------------------------- | ----------------- |
| macOS   | `~/.pluggy/bin/pluggy`                      | Yes.              |
| Linux   | `~/.pluggy/bin/pluggy`                      | Yes.              |
| Windows | `%LOCALAPPDATA%\Programs\pluggy\pluggy.exe` | Yes.              |

The install scripts (`install.sh`, `install.ps1`) use these defaults
and never need `sudo`. Override the Unix install root with
`PLUGGY_HOME` (the binary is always placed at `$PLUGGY_HOME/bin/pluggy`).

`install.sh` adds `$PLUGGY_HOME/bin` to your `PATH` by appending an
`export` line to whichever of `~/.zshrc`, `~/.bashrc`, `~/.bash_profile`,
`~/.profile`, and `~/.config/fish/config.fish` exist. The line is
idempotent — re-running the installer doesn't duplicate it.

If a previous install left `pluggy` at `/usr/local/bin/pluggy`, the
new install script warns you so the legacy copy doesn't shadow the
fresh one on `PATH`. Remove it with `sudo rm /usr/local/bin/pluggy`.

On Windows, the install script appends the install directory to your
user `PATH`. Restart your terminal to pick up the change.

## Cache paths

pluggy derives its cache path from the OS:

| OS      | Path                                                   |
| ------- | ------------------------------------------------------ |
| macOS   | `~/Library/Caches/pluggy/`                             |
| Linux   | `$XDG_CACHE_HOME/pluggy/` (default `~/.cache/pluggy/`) |
| Windows | `%LOCALAPPDATA%\pluggy\cache\`                         |

The layout is identical on every OS:

```text
<cache>/
├── dependencies/
│   ├── modrinth/<slug>/<version>.jar
│   ├── maven/<group>/<artifact>/<version>.jar
│   └── file/<sha256-hex>.jar
├── versions/
│   └── <platform>-<version>-<build>.jar
├── BuildTools.jar
└── BuildTools/
```

Wipe the cache with `rm -rf <cache-path>` (POSIX) or
`Remove-Item -Recurse $env:LOCALAPPDATA\pluggy\cache` (PowerShell).
pluggy rebuilds everything on the next command.

`pluggy doctor` reports the cache size.

## Paths in `project.json` and `pluggy.lock`

Always forward-slashed, regardless of host OS. pluggy normalizes paths
to POSIX form through `toPosixPath` before writing either file. This
keeps `project.json` portable across a team where some members are on
Windows and others aren't.

When you read paths out of `project.json` (e.g. in `resources`), pluggy
resolves them to OS-native paths at runtime — you don't need to do
anything.

## Line endings

Every generated file is LF-only: `project.json`, `pluggy.lock`,
`plugin.yml`, `server.properties`, IDE scaffolding, the initial
`Main.java`. pluggy writes through `writeFileLF` which strips `\r\n` →
`\n` before the disk call, so Windows users don't end up with mixed
endings in their repo.

Text files you drop into the project yourself (e.g. your own source
files) are not rewritten — pluggy only normalizes what it produces.

## Path-separator handling

The Java classpath separator is `:` on POSIX and `;` on Windows. pluggy
uses Node's `path.delimiter` everywhere classpaths are joined, so this
works automatically.

File and directory paths are joined with Node's `path.join` (OS-native
separators) internally, and `path.posix.join` for zip entry paths inside
the output jar.

## Hardlinks, copies, and symlinks

Any time pluggy needs to place a jar into a secondary location (e.g.
`dev/plugins/<name>.jar` from a cache file, or a workspace-local IDE
jar), it tries a hardlink first and falls back to a byte copy. It never
creates symlinks — Windows symlinks require administrator rights or
Developer Mode, which you can't assume on end-user machines.

Hardlinks require the source and destination to be on the same
filesystem. Cross-filesystem operations fail with `EXDEV`/`EPERM` and
silently fall back to a copy, which is slower but correct.

## Process spawning

pluggy never spawns through a shell. Every `child_process.spawn` call is
given an argv array directly, which:

- avoids quoting bugs for paths with spaces or special characters, and
- works identically on Windows (which has its own command-quoting rules).

On Windows, Node's spawn handles `.exe` / `.cmd` / `.bat` lookup
internally when you spawn `"java"` or any other command — you don't
need to append `.exe` yourself.

## Signal handling

`pluggy dev` installs a SIGINT handler through
`portable.installShutdownHandler`. The handler:

- First Ctrl+C: writes the graceful-stop command to the child's stdin
  and starts a 30-second grace timer. When it fires, the child is sent
  `SIGTERM` (POSIX) or its Windows equivalent.
- Second Ctrl+C within 2 seconds: force-kill with SIGKILL.

Node translates Windows Ctrl+C events into `SIGINT` for you, so this
works the same on every OS. The handler is removed cleanly when the
child exits.

Note that SIGKILL on Windows is actually `TerminateProcess` — there's no
graceful grace period and world data may not flush.

## `$PATH` on macOS/Linux

`install.sh` writes the line `export PATH="$HOME/.pluggy/bin:$PATH"`
into every shell profile it finds. New shells pick this up
automatically. To use pluggy in the same shell that ran the installer,
run that export by hand or `source` the relevant profile.

## `%PATH%` on Windows

pluggy's install script adds `%LOCALAPPDATA%\Programs\pluggy` to your
user `PATH`. If the `pluggy` command isn't found after install:

- Restart the terminal (the update doesn't propagate to already-open
  sessions).
- Verify: `(Get-ItemProperty HKCU:\Environment).Path` should contain the
  pluggy install directory.
- Add it manually if needed: `[Environment]::SetEnvironmentVariable(
"Path", "$env:Path;$env:LOCALAPPDATA\Programs\pluggy", "User")`.

## PowerShell vs cmd.exe

pluggy itself works identically in both. The install script
(`install.ps1`) is PowerShell-specific. `cmd.exe` users can download the
binary directly from the release page and place it on `PATH` manually.

## WSL

Running pluggy under WSL works — it's just Linux from pluggy's
perspective. The cache path follows WSL's Linux HOME
(`/home/<user>/.cache/pluggy`), not your Windows one. Don't expect to
share a cache between a Windows pluggy install and a WSL one.

## See also

- [`pluggy upgrade`](./commands/upgrade.md) — asset naming per OS/arch.
- [`pluggy doctor`](./commands/doctor.md) — environment checks.
- [Dev server](./dev-server.md) — shutdown semantics in detail.
