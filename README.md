```
 ____  _
|  _ \| |_   _  __ _  __ _ _   _
| |_) | | | | |/ _` |/ _` | | | |
|  __/| | |_| | (_| | (_| | |_| |
|_|   |_|\__,_|\__, |\__, |\__, |
               |___/ |___/ |___/
```

# pluggy

pluggy is a Minecraft plugin toolchain that fits in one binary. Scaffold a project, install plugins from Modrinth, pull Maven artifacts with their full transitive closure, and run a live Paper, Spigot, or Velocity server that rebuilds on save.

## Install

Install pluggy with the script for your platform. Both scripts drop the binary on your `PATH` without root or administrator rights.

On macOS and Linux:

```bash
curl -fsSL https://github.com/pluggy-sh/pluggy/releases/latest/download/install.sh | bash
```

On Windows (PowerShell):

```powershell
irm https://github.com/pluggy-sh/pluggy/releases/latest/download/install.ps1 | iex
```

Open a new terminal and verify:

```bash
pluggy -V
```

To upgrade in place later, run `pluggy upgrade`.

## Quick start

Go from an empty directory to a running server in three commands:

```text
$ pluggy init --yes --name shop --main com.example.shop.Main

$ pluggy install worldedit
Installed worldedit into shop (1 resolved).

$ pluggy dev
dev: starting shop
```

That gives you this layout:

```text
shop/
├── project.json
├── pluggy.lock
└── src/
    ├── com/example/shop/Main.java
    └── config.yml
```

And this `project.json`:

```json
{
  "name": "shop",
  "version": "1.0.0",
  "main": "com.example.shop.Main",
  "compatibility": {
    "versions": ["1.21.8"],
    "platforms": ["paper"]
  },
  "dependencies": {
    "worldedit": {
      "source": "modrinth:worldedit",
      "version": "7.3.15"
    }
  }
}
```

Save a `.java` file and pluggy rebuilds the jar, restarts the server, and lands you back at the Paper console, typically inside a second. Ship a release jar with one more command:

```text
$ pluggy build
✔ shop: bin/shop-1.0.0.jar (142.4 KB, 3821ms)
```

## Why pluggy

pluggy collapses every step of plugin development into one binary: scaffold, dependency resolution, build, dev loop, and IDE setup. The list below covers what that buys you, with the command that demonstrates each.

- **JDK provisioning, no setup.** `pluggy build` derives the required Java major from your MC version and downloads a matching Temurin JDK from the [Foojay Disco API](https://api.foojay.io/disco/v3.0/distributions). Set `JAVA_HOME` to keep your existing toolchain instead, or `PLUGGY_NO_AUTO_INSTALL=1` for CI.
- **Modrinth in one line.** `pluggy install worldedit` resolves the latest stable, downloads it, and locks the SHA-256. No registry config, no version pinning required up front.
- **Maven without XML.** `pluggy install maven:net.kyori:adventure-api@4.17.0` parses the POM, folds in `<dependencyManagement>` BOM imports, and lands the full transitive closure on the classpath. SNAPSHOT versions resolve through per-version metadata.
- **Live server in one command.** `pluggy dev` downloads the matching Paper, Spigot, or Velocity jar, accepts the EULA, hardlinks your plugin and runtime deps into `plugins/`, and boots the server. File saves trigger a debounced rebuild and restart.
- **Seven server platforms.** paper, folia, spigot, bukkit, velocity, waterfall, and travertine, each with its own descriptor format and Maven API coordinate. Switch by editing `compatibility.platforms` in `project.json`.
- **Cross-platform, identically.** The same binary runs on macOS, Linux, and Windows. Paths normalize to forward slashes, generated files use LF line endings, and shutdown handling works the same on every OS.
- **Reproducible by default.** Every resolved dep is recorded in `pluggy.lock` with a SHA-256 hash. The lockfile is sorted, LF-terminated, and written atomically. Diffs stay small and merges stay sane.
- **IDE-aware.** List editors in `"ide": ["vscode", "eclipse", "intellij"]` and `pluggy build` scaffolds the right project files for every entry.
- **Workspaces.** Monorepo layouts with inheritance, topological build order, and a `workspace:` source kind for sibling dependencies.

## Commands

pluggy exposes a small set of commands. Every command supports `--json` for structured output and `--help` for inline help.

| Command                      | Summary                                            |
| ---------------------------- | -------------------------------------------------- |
| `pluggy init`                | Scaffold a new project.                            |
| `pluggy install [plugin]`    | Add a dependency or reconcile the lockfile.        |
| `pluggy remove <plugin>`     | Drop a dependency and its cached jar.              |
| `pluggy info <plugin>`       | Inspect a source.                                  |
| `pluggy search <query>`      | Query Modrinth.                                    |
| `pluggy list`                | Show declared deps, resolved versions, registries. |
| `pluggy build`               | Compile, package resources, and produce a jar.     |
| `pluggy test`                | Compile and run JUnit tests under `test/`.         |
| `pluggy docs`                | Generate Javadoc HTML for the project.             |
| `pluggy dev`                 | Run a live server that rebuilds on save.           |
| `pluggy sdk`                 | Manage the JDKs pluggy provisions for builds.      |
| `pluggy doctor`              | Validate the environment and every workspace.      |
| `pluggy upgrade`             | Replace the binary with the latest release.        |
| `pluggy completions <shell>` | Print a shell completion script.                   |

For per-command flags, JSON envelopes, and sample output, see the [command reference](./docs/commands/).

## Documentation

The full documentation lives under [`docs/`](./docs/). Start with the getting-started guide; the rest is reference.

- [Getting started](./docs/getting-started.md): install, scaffold, build, run a dev server.
- [project.json reference](./docs/project-json.md): every field and validation rule.
- [Dependency sources](./docs/dependencies.md): the Modrinth, Maven, file, and workspace grammar.
- [Build pipeline](./docs/build-pipeline.md): what happens between `pluggy build` and the jar.
- [Dev server](./docs/dev-server.md): staging directory, EULA, reload semantics, shutdown.
- [Workspaces](./docs/workspaces.md): monorepo layout, inheritance, topological order.
- [IDE integration](./docs/ide.md): what pluggy writes for VS Code, Eclipse, and IntelliJ.
- [Cross-platform notes](./docs/cross-platform.md): paths, line endings, signal handling.
- [Troubleshooting](./docs/troubleshooting.md): common failures and how to fix them.

## Contributing

pluggy is written in TypeScript. The development loop runs through Vite+ (`vp check`, `vp test`) and the shipped CLI binary is produced by `bun build --compile`.

For the development loop, see [CONTRIBUTING.md](./CONTRIBUTING.md). For repo conventions (cross-platform rules, command shape, and the stub-module workflow), see [CLAUDE.md](./CLAUDE.md).

## License

pluggy is released under the MIT License. See [LICENSE](./LICENSE).

## Next steps

- New to pluggy: read the [getting started guide](./docs/getting-started.md).
- Migrating from Maven or Gradle: see the [migration recipe](./docs/recipes/migrating-from-maven-gradle.md).
- Setting up CI: see the [CI without global pluggy recipe](./docs/recipes/ci-without-global-pluggy.md).
