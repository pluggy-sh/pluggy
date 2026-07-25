# `pluggy dev`

Run a live Minecraft server with your plugin and its runtime dependencies loaded. Rebuilds and restarts on source change. Hotswap is on by default, so most code changes apply without restarting the server.

## Usage

```text
pluggy dev [options]
```

## Flags

| Flag                     | Default                              | Notes                                                                                                                              |
| ------------------------ | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `--workspace <names>`    | none                                 | Pick a workspace at the root. Only needed when shipping workspaces span platforms; same-platform workspaces co-host on one server. |
| `--platform <id>`        | `project.compatibility.platforms[0]` | Override the platform (for example `paper` to `spigot`).                                                                           |
| `--mc-version <version>` | `project.compatibility.versions[0]`  | Override the Minecraft version (accepts `1.21` or `1.21.8`).                                                                       |
| `--port <n>`             | `project.dev.port` or `25565`        | Written into `server.properties`.                                                                                                  |
| `--memory <x>`           | `project.dev.memory` or `2G`         | JVM heap size; becomes `-Xmx<value>`.                                                                                              |
| `--clean`                | off                                  | Wipe `dev/` before staging.                                                                                                        |
| `--fresh-world`          | off                                  | Keep `dev/` but delete every `dev/world*` subdirectory.                                                                            |
| `--no-watch`             | watch on                             | Run once. Don't restart on change.                                                                                                 |
| `--fallback <mode>`      | `manual`                             | What to do when a change can't be hotswapped: `manual`, `restart`, or `reload`.                                                    |
| `--no-hotswap`           | hotswap on                           | Rebuild and restart on change instead of hotswapping. Implies `--fallback restart`.                                                |
| `--debug [port]`         | off                                  | Attach a JDWP debug agent for IDE breakpoints. Port defaults to `5005`.                                                            |
| `--debug-suspend`        | off                                  | With `--debug`, wait for a debugger to attach before starting. Implies `--debug`.                                                  |
| `--offline`              | off                                  | Force `online-mode=false` in `server.properties`.                                                                                  |

`dev` runs one server, so `--workspace` takes exactly one name. Passing two fails with `E_WORKSPACE_NOT_SINGLE`:

```text
$ pluggy dev --workspace api,core
error [E_WORKSPACE_NOT_SINGLE]: dev works on one workspace, but 2 were selected (api, core).
  hint: One server hosts one platform. Pick one: --workspace api
```

JDWP binds to loopback. To let a debugger on another host attach (a container, WSL2), set [`dev.debug.exposed`](../project-json.md#devdebug) in `project.json`. JDWP is unauthenticated, so exposing it hands remote code execution to anything that can reach the port.

## What it does

1. Resolves the primary platform (`paper` by default) and Minecraft version.
2. Downloads the platform jar into the cache (`~/Library/Caches/pluggy/versions/<id>-<ver>-<build>.jar` on macOS; equivalent paths on Linux and Windows).
3. Runs a full `pluggy build` for the target workspace.
4. Resolves runtime plugin dependencies. pluggy opens each declared dep as a zip and flags those containing the platform's [descriptor](../glossary.md#descriptor) (`plugin.yml`, `bungee.yml`, `velocity-plugin.json`, or `META-INF/sponge_plugins.json`) as runtime plugins. Compile-only libraries stay out of `dev/plugins/`.
5. Stages `dev/` next to the workspace's `project.json`:
   - `dev/server.jar` is hardlinked (copy fallback) from the cached platform jar.
   - `dev/eula.txt` is `eula=true` with an auto-accepted header. Set `PLUGGY_DEV_NO_EULA=1` to have pluggy leave the file alone so you can accept Mojang's EULA yourself.
   - `dev/server.properties` is generated from the project defaults, merged with `project.dev.serverProperties`.
6. Populates `dev/plugins/` with the plugin jar, runtime plugin deps, and `project.dev.extraPlugins`. Each entry is hardlinked by basename.
7. Provisions the [JetBrains Runtime](#hotswap) (JBR) and the dev agent on the first run, unless `--no-hotswap` or `dev.hotswap: false` is set.
8. Spawns `<java> -Xmx<mem> <jvmArgs> -javaagent:<pluggy-agent.jar> -jar server.jar nogui` inside `dev/`. The trailing `nogui` suppresses Bukkit's AWT console window so dev sessions stay headless.

## The `dev/` layout

```text
dev/
├── server.jar
├── eula.txt
├── server.properties
├── world/           (created by the server on first run)
├── world_nether/
├── world_the_end/
├── logs/
└── plugins/
    ├── my_plugin-1.0.0.jar
    └── worldedit-7.3.15.jar
```

Everything under `dev/` is safe to delete. `--clean` wipes it. `--fresh-world` keeps it but removes every `dev/world*` subdirectory.

## Hotswap

Hotswap is the default. With it enabled, most code changes apply to the running server without a restart. pluggy provisions two pieces on first use:

- **JetBrains Runtime** (JBR): a JDK with enhanced class redefinition, so redefinition isn't limited to method bodies. Cached under `<cache>/jbr/`.
- **The pluggy dev agent**: a Java agent embedded in the binary that connects back to pluggy over a loopback socket and redefines changed classes on request. Written to `<cache>/agents/pluggy-agent-<hash>.jar` on first use.

When you save a file, pluggy debounces for 200 milliseconds, rebuilds, and asks the agent to redefine the changed classes. If a change is too deep to redefine (a new supertype, for example), the `--fallback` mode decides what happens next.

Disable hotswap with `--no-hotswap` or by setting `"hotswap": false` under `dev` in `project.json`:

```json
"dev": {
  "hotswap": false,
  "fallback": "restart"
}
```

See the [`dev` block in the `project.json` reference](../project-json.md#dev-optional) for the full schema.

## What happens when hotswap can't apply a change

`--fallback` (or `dev.fallback`) picks between three modes. The default is `manual` with hotswap on, and `restart` with `--no-hotswap`, since then every change needs a restart anyway.

| Mode      | Behaviour                                                                                                                  |
| --------- | -------------------------------------------------------------------------------------------------------------------------- |
| `manual`  | Logs `· restart to apply` and leaves the server alone. Type `restart` (or `rs`) in the console when you're ready.          |
| `restart` | Writes `stop` to the server, waits for exit, swaps the jar, respawns the JVM. Safe, and slow: tens of seconds.             |
| `reload`  | Swaps the jar under `dev/plugins/` and sends `reload confirm` to the server. Fast, and uses Bukkit's deprecated `/reload`. |

`reload` is unreliable for plugins that hold state across reloads: listener registration, static caches, ClassLoader-pinned objects. Pick it only when you know your plugin is reload-clean.

pluggy's console intercepts `restart` and `rs`; every other line goes straight through to the server.

Rebuild failures don't restart the server. pluggy keeps the previous jar running and logs the failure:

```text
✗ Rebuild failed, keeping previous jar running: compile: javac exited with code 1 ...
```

## Shutdown

- First Ctrl+C: writes `stop` to the server. pluggy waits up to 30 seconds for a clean exit. If the server doesn't exit in time, `child.kill()` sends the default signal (SIGTERM on POSIX, equivalent on Windows via Node's kill shim).
- Second Ctrl+C within 2 seconds: SIGKILL the server immediately.

The signal handler is installed via `installShutdownHandler` from `portable.ts` and works the same on macOS, Linux, and Windows.

The dev command returns after the server exits and the watcher tears down.

## Watching

pluggy watches:

- `<workspace>/src/` recursively.
- Every directory referenced by `project.resources` (recursive, normalised to the parent dir; atomic-rewrite editors evict the file inode, so file-level watchers die, while watching the directory survives).
- The directory containing `project.json`.

Debounce is 200 milliseconds. A burst of saves coalesces into one rebuild.

## Human output

```text
$ pluggy dev
[server output on stdout/stderr, unfiltered]
```

## JSON output

`--json` on `dev` writes exactly one JSON line at startup, then hands stdout and stderr to the server unchanged.

```json
{
  "status": "starting",
  "platform": "paper",
  "version": "1.21.8",
  "port": 25565,
  "devDir": "/repo/dev"
}
```

This is designed for CI and process supervisors. After the envelope line, the rest of stdout is Minecraft's own logs.

## Error cases

| Trigger                                 | Message                                                                                                                                                                                                        |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Multi-workspace root, no `--workspace`  | If exactly one workspace declares `main`, `dev` auto-picks it and logs the choice. Otherwise it errors with a table listing each workspace's `main` and `compatibility.platforms` so the ambiguity is obvious. |
| `--workspace X` from inside workspace Y | `--workspace "X" does not match the current workspace "Y". Run from the root to target a different workspace.`                                                                                                 |
| No platforms declared                   | `runDev: no platform configured, set compatibility.platforms[0] or pass --platform`                                                                                                                            |
| `java` not on PATH                      | Standard `spawn ENOENT`. See [Troubleshooting](../troubleshooting.md#java-not-found-from-the-dev-server-spawn).                                                                                                |

## See also

- [Dev server deep dive](../dev-server.md): staging, EULA, shutdown, extraPlugins.
- [`pluggy build`](./build.md): the same build is what `dev` runs on every change.
- [`pluggy doctor`](./doctor.md): check your JDK and project before starting a dev session.
