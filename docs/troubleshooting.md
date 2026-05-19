# Troubleshooting

Find your error here, then read the fix. Entries are grouped by the command that surfaces them, with the exact error message shown verbatim under each section so you can Ctrl-F the text pluggy printed. Placeholders in error messages use `<...>` for interpolated values. If a term is unfamiliar, check the [glossary](./glossary.md).

## Error format

Every typed error pluggy emits has the same shape. Knowing the shape makes scanning the messages below faster.

Human output:

```text
error [E_INSTALL_NO_REGISTRIES]: Maven: no registries configured for "net.kyori:adventure-api:4.17.0".
  hint: Declare a Maven registry in project.json:registries, or use a github: alias.
  at /Users/you/my-plugin/project.json (/registries)
  caused by: <upstream message, when chained>
```

The `[E_*]` code is stable and scriptable. The `hint:` line offers a one-line next step. `at <file>` points at the source location when the error refers to a file. `caused by:` shows underlying errors when a higher-level error wraps a lower-level one.

JSON envelope:

```json
{
  "status": "error",
  "exitCode": 2,
  "message": "Maven: no registries configured for \"net.kyori:adventure-api:4.17.0\".",
  "code": "E_INSTALL_NO_REGISTRIES",
  "hint": "Declare a Maven registry in project.json:registries, or use a github: alias.",
  "source": { "file": "/Users/you/my-plugin/project.json", "pointer": "/registries" }
}
```

Exit codes: `2` for user input problems (`UserError`), `1` for runtime failures (`RuntimeError`, network outages, disk problems), `1` for unexpected internal errors (no `code` field). Only `UserError` exits `2`.

## `pluggy init`

### Invalid project name

Pick a name made of letters, digits, underscores, and hyphens only. `--name` must match `^[a-zA-Z0-9_-]+$`. Dots and Unicode aren't allowed. This is enforced by `init` and checked again by `doctor`.

```text
Invalid project name: "<name>". Only alphanumeric characters, underscores, and hyphens are allowed.
```

### Invalid main class

`--main` must be a dotted Java class path with at least one dot (`package.Class`). Single-word class names aren't accepted. Java requires a package for production plugin classes.

```text
Invalid main class: "<main>". It must be a valid Java classpath (e.g., com.example.Main).
```

### Network errors during `init` or `dev`

`pluggy init` calls `getVersions()` on every selected platform in parallel and picks the highest version they all publish. If your network is offline or the upstream is down:

- Pass `--mc-version <semver>` to skip the network call entirely.
- Or set a version in `project.json` after `init` completes.

### No compatible Minecraft version across platforms

pluggy couldn't find a Minecraft version that every selected platform publishes. Most often this is a short-lived gap where one provider publishes a new release before another (for example Paper ships `26.1.2` hours or days before Spigot's BuildTools catches up). Either drop the platform that's lagging, or pin the version yourself with `--mc-version`.

```text
No compatible Minecraft version found across platforms: <list>.
```

### Platforms from different families on `--platform`

`--platform` was given values from two different descriptor families (for example `paper` and `velocity`). A single plugin jar can only target one family: server plugins (`paper`, `folia`, `spigot`, `bukkit`), BungeeCord proxy plugins (`waterfall`, `travertine`), Velocity plugins, or Sponge plugins. Re-run init for the second family in a sibling directory, or split an existing monorepo using [workspaces](./workspaces.md#multi-family-monorepos).

```text
Platform "<b>" cannot be combined with "<a>" because they target different plugin families ...
```

### BuildTools fails on a fresh spigot project

pluggy provisions a JDK matching the chosen Minecraft version's class-file range, so a build mismatch normally can't happen. If BuildTools still errors out (typically `FileNotFoundException ... DataComponentPatch.java`), the most likely cause is `JAVA_HOME` taking precedence and pointing at a toolchain that doesn't satisfy the range. Unset `JAVA_HOME` to force pluggy to provision its own JDK, or pin the JDK explicitly with [`pluggy sdk use`](./commands/sdk.md#use).

`pluggy dev` also hits the platform registry for the server jar. The first run per `(platform, version)` needs network; subsequent runs reuse the cache.

## `pluggy install` / `pluggy remove`

### `install` at the workspace root needs `--workspace`

You ran `pluggy install <identifier>` at a multi-workspace root. pluggy doesn't know which workspace to add the dep to. Pass `--workspace <name>` to choose one.

```text
install: at the workspace root, pass --workspace <name> to pick a target for "<plugin>"
```

### `--workspaces` plus a specific plugin

You can't add one dep to every workspace in one command. Pick a single workspace with `--workspace <name>` instead.

```text
install: --workspaces and a specific [plugin] are mutually exclusive, pick one workspace with --workspace <name>
```

### Conflicting dep versions across workspaces

Two workspaces declare the same dep with different versions. Bulk install refuses to pick a winner. Align the versions in `project.json` by hand, then rerun.

```text
install: conflicting declarations of "<name>" across workspaces: <source>@<v1> vs <source>@<v2>
```

### No Maven registries configured

Maven deps need at least one entry in `project.json:registries`. Maven Central is a common default:

```json
"registries": ["https://repo1.maven.org/maven2/"]
```

```text
Maven: no registries configured for "<g>:<a>:<v>". Declare a Maven registry in project.json:registries.
```

### Maven coordinate not found

The artifact wasn't found at any registry in your list. The "Tried:" block shows the exact URL for each attempt and the HTTP response. Use that to diagnose.

Common causes:

- Typo in the coordinate. Maven is case-sensitive.
- Missing registry for a non-Central artifact (for example PaperMC's Maven repo for `paper-api`).
- 401 on a private registry with missing or wrong credentials.

```text
Maven: could not resolve "<coord>" from any configured registry. Tried: ...
```

### Modrinth version not found

The exact version string doesn't exist. Modrinth uses the plugin's declared `version_number`, which may not be a clean semver. Check `pluggy info <slug>` or `https://modrinth.com/plugin/<slug>/versions` to see the real strings.

```text
Modrinth: version "<v>" not found for slug "<slug>". available: <top-3>, ...
```

### Modrinth pre-release needs `--beta`

You asked for a specific pre-release without `--beta`. Re-run with `--beta` to accept alpha and beta versions.

```text
Modrinth: version "<v>" of "<slug>" is a <type> release; pass --beta to install pre-releases
```

### Removing a plugin that isn't installed

You asked to remove something that isn't there. Check `pluggy list` for the actual dep names. The key in `dependencies` is what `remove` wants, not the slug.

```text
remove: "<plugin>" is not declared in <workspace> (<path>)
```

### `remove` at the workspace root needs `--workspace`

At a multi-workspace root, `remove` refuses to guess. Pick one workspace with `--workspace <name>` or confirm "all" with `--workspaces`.

```text
remove: at the workspace root, pass --workspace <name> or --workspaces to disambiguate
```

## `pluggy build`

### Mixed descriptor families in `compatibility.platforms`

`compatibility.platforms` contains a mix of Bukkit-family (paper, folia, spigot, bukkit), BungeeCord-family (waterfall, travertine), Velocity, and Sponge. One plugin, one descriptor. Move the others into separate workspaces. See [Multi-family monorepos](./workspaces.md#multi-family-monorepos).

```text
build: project "<name>" declares platforms from different descriptor families ("<a>" uses "<path1>", "<b>" uses "<path2>"). Split them into separate workspaces, one per family.
```

### `javac` compile errors

Standard Java compile errors. pluggy surfaces the last 40 stderr lines verbatim. Fix the errors in your editor and re-run.

```text
compile: javac exited with code <n> for project "<name>" (last 40 lines): ...
```

### No Java sources found

The workspace's `src/` directory is empty or missing. pluggy expects sources to live under `<workspace>/src/`.

```text
compile: no .java sources found under "<dir>" for project "<name>"
```

### `javac` not found

The cached JDK pluggy resolved is missing or its slot was deleted out of band. Run `pluggy sdk install` to repopulate the cache, or `pluggy sdk path <major>` to verify the slot exists. The `<path>` in the error is the absolute `javac` pluggy expected.

If the spawn is for `javac` (no path prefix), pluggy fell back to `PATH` because `compileJava` was invoked without a resolved JDK. That's normally unreachable from CLI commands. File an issue with the surrounding output.

```text
compile: failed to spawn javac for project "<name>": spawn <path> ENOENT
```

### Sibling workspace not built yet

You're shading a `workspace:` dep from inside a workspace. From the repo root, `pluggy build` orders workspaces topologically and the sibling builds first. Run from the root, or run `pluggy build --workspace <dep>` first then the dependent.

```text
shade: workspace dependency "<name>" has not been built yet, expected jar at "<path>". Build the sibling workspace first (topological order is the caller's responsibility).
```

### Resource path missing

A `resources` entry points at a file or directory that doesn't exist. Check the path relative to the project root.

```text
resources: source path "<rel>" (key "<key>") does not exist at "<abs>"
```

## `pluggy dev`

### `java` not found at dev server start

Same root cause as the `javac` entry above: the JDK slot is missing. `pluggy dev` runs the server JVM with the same JDK that compiled it. Run `pluggy sdk install` to repopulate.

```text
java not found
```

### JDK not installed in CI mode

The CI escape hatch is set and the cache is cold. Pre-warm with `pluggy sdk install` in a step before the failing command, or unset the env var. The error already includes the exact command to run.

```text
sdk: <distribution> JDK <major> is not installed and PLUGGY_NO_AUTO_INSTALL=1.
```

### Server hangs on first startup

First run per platform-version downloads the server jar (Paper) or runs BuildTools (Spigot/Bukkit). BuildTools can take minutes on slow machines because it compiles CraftBukkit or Spigot from source through a Mojang mapping step. Second run is fast. The jar is cached.

### Plugin doesn't load despite compiling

Check the server logs in `dev/logs/latest.log`. Common causes:

- `plugin.yml` main class doesn't match the compiled class name. Did you rename the Java class without updating `project.main`?
- The plugin depends on another plugin (`depend:` in `plugin.yml`) that isn't in `dev/plugins/`. Add it to `dependencies` or `project.dev.extraPlugins`.
- `api-version` mismatch. pluggy derives `api-version` from `compatibility.versions[0]` (`"1.21.8"` becomes `"1.21"`). If you need `api-version` unset, provide your own `plugin.yml` via `project.resources`.

### Hotswap reports "redefinition failed"

Some changes can't be applied to a running JVM: adding a supertype, changing a class hierarchy, or rewriting a method that's already on the call stack. pluggy falls back automatically to either `/reload` or a full restart, depending on `dev.hotswap.fallback`. If you keep hitting this, bump `dev.hotswap.fallback` to `"restart"` so the server starts clean every time.

### `/reload` misbehaves but full restart works

Don't use `--reload`. Bukkit's `/reload` has known reliability problems with stateful plugins. Full restart is slower but correct.

## `pluggy doctor`

### `java` not on `PATH`

`doctor` probes the host's `java` for visibility, separately from the JDK pluggy provisions for builds. Builds still work without `java` on `PATH`. Install a JDK to silence this check, or rely on the `Project JDK` check below for a pluggy-managed verdict.

```text
✗ Java toolchain: java not found or failed to run: spawn java ENOENT
```

### Project JDK not yet installed

The required JDK isn't cached, but auto-install is on. The next `pluggy build` will download it. Pre-install with `pluggy sdk install <major>` if you want the download to happen now.

```text
! Project JDK: temurin <major> not yet installed, pluggy will fetch on first build.
```

### Project JDK missing in CI mode

The CI escape hatch is set and the cache is cold. Pre-warm with the exact command in the message, or unset the env var.

```text
✗ Project JDK: temurin <major> not installed and PLUGGY_NO_AUTO_INSTALL=1
```

### Host Java older than BuildTools floor

The host `java` is older than the floor declared by the cached `BuildTools.jar` (read from its `Build-Jdk-Spec` manifest attribute). This is a warning. pluggy uses its own provisioned JDK for the build, so the host version usually doesn't matter. Fix this if a tool outside pluggy depends on the host `java`.

```text
! Java toolchain: Java <x>, BuildTools requires Java <y>+
```

### Cache directory not writable

The cache directory exists but pluggy can't write to it. Typical causes:

- Wrong ownership (for example you ran `sudo pluggy` once and `root` owns the cache). Fix with `sudo chown -R $USER <cache-path>`.
- Disk full.
- Filesystem mounted read-only.

```text
✗ Cache reachability: cache is not writable: <path> (<errno>)
```

### Registry unreachable

A declared Maven registry didn't respond to a `HEAD` with a 2xx, 3xx, or 4xx. This is a warning. Some registries legitimately reject HEAD. Try `pluggy install maven:<coord>@<version>` to see the real error from the resolver.

```text
! Registry <url>: unreachable: <errno>
```

### Workspace dependency cycle

Two workspaces depend on each other through `workspace:`. This is a build-order impossibility. Break the cycle by extracting a third workspace that both sides depend on.

```text
✗ Workspace graph: workspace dependency cycle detected: <a> -> <b> -> <a>
```

## Lockfile

### Lockfile won't parse

`pluggy.lock` is malformed. Usually a merge conflict marker left over from a rebase. Delete the file and run `pluggy install --force` to regenerate.

```text
Failed to parse lockfile at <path>: <json-error>
```

### Lockfile version too new

Someone wrote a newer-format lockfile with a newer pluggy. Upgrade pluggy with `pluggy upgrade`.

```text
Unsupported lockfile version: <n> (at <path>; expected 2)
```

### Invalid lockfile entry

Manual edit that broke the schema. Delete the entry and rerun `pluggy install`.

```text
Invalid lockfile entry "<key>" at <path>: ...
```

## Environment

### Out of disk space

The cache directory is full. `pluggy doctor` and `pluggy cache info` report the current size. Wipe with [`pluggy cache clean`](./commands/cache.md). pluggy rebuilds on the next command.

```text
Error: ENOSPC: no space left on device
```

### Windows: `pluggy` not recognized after install

The install script adds the binary directory to your user `PATH`, but open terminals don't see the update until they restart. Open a fresh terminal.

### macOS: Gatekeeper blocks the binary

Gatekeeper is blocking an unsigned binary because macOS sees it as quarantined. Clear the quarantine attribute:

```bash
xattr -d com.apple.quarantine ~/.pluggy/bin/pluggy
```

Or bypass once through **System Settings > Privacy & Security**.

## Still stuck?

- Run the command with `--verbose`. pluggy logs intermediate steps, registry URLs it tried, and the reason for every skip.
- Run `pluggy doctor` and paste the output into your bug report.
- Check `pluggy.lock` and `project.json` with a JSON linter. A stray trailing comma will break parsing in ways that don't always surface at the parse line.
