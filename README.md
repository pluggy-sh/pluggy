```
 ____  _
|  _ \| |_   _  __ _  __ _ _   _
| |_) | | | | |/ _` |/ _` | | | |
|  __/| | |_| | (_| | (_| | |_| |
|_|   |_|\__,_|\__, |\__, |\__, |
               |___/ |___/ |___/
```

# pluggy

A CLI for Minecraft plugin development. Scaffold a project, pull
dependencies from Modrinth / Maven / local jars / sibling workspaces,
build a real plugin jar with the full Maven transitive closure on the
classpath, and boot a live Paper / Spigot / Velocity server with a
file-watcher that rebuilds on save.

Ships as a single native binary — no Gradle wrapper, no `pom.xml`, no
JVM-based toolchain to install. One JSON file per project, one lockfile
per repo.

## Install

macOS / Linux:

```bash
curl -fsSL https://github.com/ch99q/pluggy/releases/latest/download/install.sh | bash
```

Windows (PowerShell):

```powershell
irm https://github.com/ch99q/pluggy/releases/latest/download/install.ps1 | iex
```

Both scripts drop the binary somewhere on your `PATH`. Verify:

```bash
pluggy -V
```

Upgrade in place any time with `pluggy upgrade`.

## Quick tour

```bash
# Scaffold
mkdir my-plugin && cd my-plugin
pluggy init --yes --name my_plugin --main com.example.myplugin.Main

# Add deps
pluggy install worldedit                            # Modrinth
pluggy install maven:net.kyori:adventure-api@4.17.0 # Maven
pluggy install ./libs/proprietary.jar               # Local jar

# Build
pluggy build
# → bin/my_plugin-1.0.0.jar

# Run a live Paper server with rebuild-on-save
pluggy dev
```

For the full walkthrough, read
[docs/getting-started.md](./docs/getting-started.md).

## What it supports

- **Platforms.** paper, folia, spigot, bukkit, velocity, waterfall,
  travertine. Each is a first-class provider with its own descriptor
  family and Maven API coordinate.
- **Dependency sources.** Modrinth slugs, Maven coordinates, local jars
  (content-addressed by SHA-256), and sibling workspaces.
- **Transitive resolution.** The Maven resolver parses POMs, folds in
  `<dependencyManagement>` BOM imports, and handles `-SNAPSHOT` versions
  by fetching per-version metadata. Full closure on the classpath.
- **Workspaces.** Monorepo layouts with inheritance, topological build
  ordering, and `workspace:` source kind for sibling deps.
- **Cross-platform.** macOS, Linux, Windows — identical behaviour, same
  native binary format (arm64 + amd64 where available).
- **IDE integration.** VS Code, Eclipse, IntelliJ. Set `"ide": [...]` in
  `project.json` (or pick them at `init` time) and builds scaffold the
  right project files for every listed editor.
- **Reproducible.** Every resolved dep carries a SHA-256 integrity
  hash. `pluggy.lock` is sorted, LF-terminated, atomic-written.

## Commands at a glance

| Command                      | Summary                                            |
| ---------------------------- | -------------------------------------------------- |
| `pluggy init`                | Scaffold a new project.                            |
| `pluggy install [plugin]`    | Add a dep or reconcile the lockfile.               |
| `pluggy remove <plugin>`     | Drop a dep (and its cached jar).                   |
| `pluggy info <plugin>`       | Inspect a source.                                  |
| `pluggy search <query>`      | Query Modrinth.                                    |
| `pluggy list`                | Show declared deps, resolved versions, registries. |
| `pluggy build`               | Compile → resources → descriptor → shade → jar.    |
| `pluggy test`                | Compile and run JUnit tests under `test/`.         |
| `pluggy dev`                 | Live server with rebuild-on-save.                  |
| `pluggy doctor`              | Validate environment and every workspace.          |
| `pluggy upgrade`             | Replace the binary with the latest release.        |
| `pluggy completions <shell>` | Print a shell completion script.                   |

Every command is documented in [docs/commands/](./docs/commands/).

## Documentation

- **Start here:** [docs/getting-started.md](./docs/getting-started.md)
- **Config reference:** [docs/project-json.md](./docs/project-json.md)
- **Dependencies:** [docs/dependencies.md](./docs/dependencies.md)
- **Workspaces:** [docs/workspaces.md](./docs/workspaces.md)
- **Build pipeline:** [docs/build-pipeline.md](./docs/build-pipeline.md)
- **Dev server:** [docs/dev-server.md](./docs/dev-server.md)
- **IDE integration:** [docs/ide.md](./docs/ide.md)
- **Cross-platform notes:** [docs/cross-platform.md](./docs/cross-platform.md)
- **Troubleshooting:** [docs/troubleshooting.md](./docs/troubleshooting.md)
- **All docs:** [docs/README.md](./docs/README.md)

## Contributing

Source is TypeScript, organized around a commander command tree and a
pluggable platform registry. `vp check` (format + lint + typecheck) and
`vp test` (Vitest) validate changes. The shipped CLI binary is produced
by `bun build --compile`.

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the development loop and
[CLAUDE.md](./CLAUDE.md) for repo conventions (cross-platform rules,
command conventions, stub-module workflow).

## License

MIT. See [LICENSE](./LICENSE).
