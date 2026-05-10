```
 ____  _
|  _ \| |_   _  __ _  __ _ _   _
| |_) | | | | |/ _` |/ _` | | | |
|  __/| | |_| | (_| | (_| | |_| |
|_|   |_|\__,_|\__, |\__, |\__, |
               |___/ |___/ |___/
```

# pluggy

Make a Minecraft plugin without setting up Java, Maven, or Gradle first. pluggy is a single small program that scaffolds your project, installs plugin libraries from [Modrinth](https://modrinth.com) and Maven, builds your jar, and runs a live server that restarts every time you save a file.

If you have never written a Minecraft plugin before, start with the [getting-started guide](./docs/getting-started.md). It walks you from an empty folder to a running server.

## Who pluggy is for

- New Java developers who want to skip the long toolchain setup.
- Younger coders writing their first plugin and learning by doing.
- Experienced developers who want one binary instead of a build-system zoo.

You don't need a JDK, a build tool, or an IDE installed up front. pluggy provisions a Java toolchain matching your Minecraft version on the first build.

## Install

Pick whichever method matches your platform. None require admin privileges.

On macOS and Linux (install script):

```bash
curl -fsSL https://pluggy.sh/install.sh | sh
```

On macOS and Linux (Homebrew):

```bash
brew install pluggy-sh/tap/pluggy
```

On Windows (PowerShell):

```powershell
irm https://pluggy.sh/install.ps1 | iex
```

Open a new terminal and verify:

```bash
pluggy -V
```

To upgrade later: `pluggy upgrade` (install script), or `brew upgrade pluggy` (Homebrew). `pluggy doctor` shows which install method you're on.

## Quick start

Three commands take you from an empty directory to a running server.

```text
$ pluggy init --yes --name shop --main com.example.shop.Main
✓ Project "shop" initialized

$ pluggy install worldedit
✓ Installed worldedit into shop (1 resolved)

$ pluggy dev
[server output streams here]
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

Save a `.java` file and pluggy rebuilds the jar, restarts the server, and lands you back at the Paper console, usually inside a second. Ship a release jar with one more command:

```text
$ pluggy build
Building shop
✓ shop → bin/shop-1.0.0.jar (142.4 KB, 3821ms)
```

## What pluggy does for you

pluggy folds every step of plugin development into one binary: scaffolding, dependency resolution, build, dev loop, and IDE setup. The list below covers what that buys you, with the command that demonstrates each.

- **No JDK setup.** `pluggy build` works out which Java version your Minecraft version needs and downloads a matching one from the [Foojay Disco API](https://api.foojay.io/disco/v3.0/distributions). Set `JAVA_HOME` to keep your existing toolchain instead, or set `PLUGGY_NO_AUTO_INSTALL=1` for CI.
- **Modrinth in one line.** `pluggy install worldedit` resolves the latest stable version, downloads it, and locks the integrity hash. No registry config, no version pinning required up front.
- **Maven without XML.** `pluggy install maven:net.kyori:adventure-api@4.17.0` reads the published POM, follows imports, and lands every required jar (the [transitive dependencies](./docs/glossary.md#transitive-dependency)) on the classpath. SNAPSHOT versions resolve through Maven's per-version metadata.
- **Live server in one command.** `pluggy dev` downloads the matching Paper, Spigot, Velocity, or Sponge jar, accepts the EULA, links your plugin and runtime deps into `plugins/`, and boots the server. File saves trigger a debounced rebuild and restart.
- **Eight server platforms.** paper, folia, spigot, bukkit, velocity, waterfall, travertine, and sponge, each with its own descriptor and Maven coordinate. Switch by editing `compatibility.platforms` in `project.json`.
- **Cross-platform, identically.** The same binary runs on macOS, Linux, and Windows. Paths normalise to forward slashes, generated files use LF line endings, and shutdown handling works the same on every OS.
- **Reproducible by default.** Every resolved dependency is recorded in `pluggy.lock` with a SHA-256 hash. The lockfile is sorted, LF-terminated, and written atomically. Diffs stay small and merges stay sane.
- **IDE-aware.** List editors in `"ide": ["vscode", "eclipse", "intellij"]` and `pluggy build` writes the right project files for every entry.
- **Workspaces.** Monorepo layouts with inheritance, topological build order, and a `workspace:` source for sibling dependencies.

## Commands

pluggy exposes a small set of commands. Every command supports `--json` for structured output and `--help` for inline help.

| Command                      | Summary                                            |
| ---------------------------- | -------------------------------------------------- |
| `pluggy init`                | Scaffold a new project.                            |
| `pluggy install [plugin]`    | Add a dependency or reconcile the lockfile.        |
| `pluggy remove <plugin>`     | Drop a dependency and its cached jar.              |
| `pluggy info <plugin>`       | Inspect a source.                                  |
| `pluggy search <query>`      | Search Modrinth.                                   |
| `pluggy list`                | Show declared deps, resolved versions, registries. |
| `pluggy why <name>`          | Trace which top-level dep pulled in a transitive.  |
| `pluggy outdated`            | List locked deps with a newer upstream version.    |
| `pluggy audit`               | Verify cached jars against the lockfile hashes.    |
| `pluggy build`               | Compile, package resources, and produce a jar.     |
| `pluggy test`                | Compile and run JUnit tests under `test/`.         |
| `pluggy docs`                | Generate Javadoc HTML for the project.             |
| `pluggy dev`                 | Run a live server that rebuilds on save.           |
| `pluggy sdk`                 | Manage the JDKs pluggy provisions for builds.      |
| `pluggy cache`               | Inspect and prune the download cache.              |
| `pluggy doctor`              | Check the environment and every workspace.         |
| `pluggy upgrade`             | Replace the binary with the latest release.        |
| `pluggy completions <shell>` | Print a shell completion script.                   |

For per-command flags, JSON envelopes, and sample output, see the [command reference](./docs/commands/).

## Documentation

The full documentation lives under [`docs/`](./docs/). Start with the getting-started guide; the rest is reference.

- [Getting started](./docs/getting-started.md): install, scaffold, build, run a dev server.
- [Glossary](./docs/glossary.md): plain-English definitions for every term in these docs.
- [`project.json` reference](./docs/project-json.md): every field and validation rule.
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
