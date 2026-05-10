# Uninstalling pluggy

pluggy has no `pluggy uninstall` command. The install script drops a single binary on your `PATH`, edits one shell profile, and writes a cache the first time you build. To remove pluggy you reverse those three steps. This page lists the exact paths for each install method.

If you only want to free disk space without removing the CLI, run [`pluggy cache clean`](./commands/cache.md) instead. That wipes the download cache and leaves the binary in place.

## What pluggy puts on your machine

Every install method writes to four locations: the binary, a `PATH` entry pointing at it, a cache directory, and a small state directory. The cache and state paths are the same regardless of how you installed pluggy.

| Kind  | macOS                                   | Linux                                                        | Windows                        |
| ----- | --------------------------------------- | ------------------------------------------------------------ | ------------------------------ |
| Cache | `~/Library/Caches/pluggy/`              | `$XDG_CACHE_HOME/pluggy/` (default `~/.cache/pluggy/`)       | `%LOCALAPPDATA%\pluggy\cache\` |
| State | `~/Library/Application Support/pluggy/` | `$XDG_STATE_HOME/pluggy/` (default `~/.local/state/pluggy/`) | `%APPDATA%\pluggy\`            |

The cache holds downloaded JDKs, server jars, and resolved plugin jars. The state directory holds small metadata such as the last `pluggy upgrade` check. Neither is recreated until the next `pluggy` command, so it is safe to delete both.

The binary and `PATH` entry depend on the install method. The sections below cover each one.

## macOS and Linux: install script

The default `curl | sh` installer puts the binary at `~/.pluggy/bin/pluggy` (or `$PLUGGY_HOME/bin/pluggy` if you set `PLUGGY_HOME`) and appends a `# pluggy` block to every shell profile that already exists.

Remove the binary and its directory:

```bash
rm -rf "${PLUGGY_HOME:-$HOME/.pluggy}"
```

Remove the `PATH` line. The installer adds a two-line block that begins with `# pluggy` to whichever of these files exist:

- `~/.bashrc`
- `~/.bash_profile`
- `~/.zshrc`
- `~/.profile`
- `~/.config/fish/config.fish`

Open each file and delete the `# pluggy` comment plus the `export PATH=...` (or `fish_add_path`) line that follows it.

If `/usr/local/bin/pluggy` exists, an older install left it there. The installer warns about this on every run. Remove it with `sudo rm /usr/local/bin/pluggy`.

Remove the cache and state directories:

```bash
# macOS
rm -rf ~/Library/Caches/pluggy ~/Library/Application\ Support/pluggy

# Linux
rm -rf "${XDG_CACHE_HOME:-$HOME/.cache}/pluggy" \
       "${XDG_STATE_HOME:-$HOME/.local/state}/pluggy"
```

Open a new terminal so the old `PATH` is dropped, then confirm `pluggy -V` is no longer found.

## macOS and Linux: Homebrew

Homebrew tracks every file it owns, so `brew uninstall` removes the binary and its symlinks. It does not know about pluggy's cache, so you still delete that yourself.

```bash
brew uninstall pluggy
brew untap pluggy-sh/tap   # optional: drops the tap entirely

# macOS
rm -rf ~/Library/Caches/pluggy ~/Library/Application\ Support/pluggy

# Linux (Linuxbrew)
rm -rf "${XDG_CACHE_HOME:-$HOME/.cache}/pluggy" \
       "${XDG_STATE_HOME:-$HOME/.local/state}/pluggy"
```

Homebrew installs do not edit shell profiles, so there is no `PATH` line to remove.

## Windows: install script

The PowerShell installer puts `pluggy.exe` at `%LOCALAPPDATA%\Programs\pluggy\pluggy.exe` and appends that directory to your user `PATH`. Run these in PowerShell:

```powershell
# 1. Remove the binary and its directory
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\Programs\pluggy"

# 2. Remove the install directory from your user PATH
$installDir = "$env:LOCALAPPDATA\Programs\pluggy"
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
$entries = $userPath -split ";" | Where-Object { $_ -ne $installDir }
[Environment]::SetEnvironmentVariable("Path", ($entries -join ";"), "User")

# 3. Remove the cache and state directories
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\pluggy"
Remove-Item -Recurse -Force "$env:APPDATA\pluggy"
```

Open a new terminal so the updated `PATH` takes effect, then confirm `pluggy -V` is no longer found.

## Windows: Scoop

Scoop tracks the binary and the `PATH` entry it added, so `scoop uninstall` handles both. The cache lives outside Scoop's tree and you remove it yourself:

```powershell
scoop uninstall pluggy
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\pluggy"
Remove-Item -Recurse -Force "$env:APPDATA\pluggy"
```

## Per-project leftovers

Each project that ran `pluggy init`, `pluggy build`, or `pluggy dev` has its own files under the project root. Removing pluggy does not touch these. Delete them manually if you no longer want the project:

- `project.json`: the project config.
- `pluggy.lock`: the resolved dependency graph.
- `bin/`: built jars from `pluggy build`.
- `dev/`: the live server staging directory from `pluggy dev`.
- `.idea/`, `.vscode/`, `.classpath`, `.project`, `.settings/`: IDE files written when `ide` is set in `project.json`.

A clean slate is `rm -rf bin dev .idea .vscode .classpath .project .settings && rm project.json pluggy.lock` from inside the project, but most users keep the project and just remove the CLI.
