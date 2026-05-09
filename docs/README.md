# pluggy docs

A CLI for Minecraft plugin development. Scaffold a project, pull dependencies
from Modrinth / Maven / local jars / sibling workspaces, build a real plugin
jar with the full Maven transitive closure on the classpath, and boot a live
Paper / Spigot / Velocity server with a file-watcher that rebuilds on save.

Ships as a single native binary. No global JVM-based toolchain, no Gradle
wrapper, no `pom.xml`. One JSON file per project.

## Start here

- [Getting started](./getting-started.md): install, scaffold, build, run a
  dev server. Eight minutes from zero to a live server.
- [project.json reference](./project-json.md): every field, every form, and
  the validation rules.
- [Dependency sources](./dependencies.md): the Modrinth / Maven / file /
  workspace grammar.

## Commands

Every subcommand, with its flags, JSON envelope, and sample output.

| Command                                    | Summary                                                  |
| ------------------------------------------ | -------------------------------------------------------- |
| [`init`](./commands/init.md)               | Scaffold a new project in an empty directory.            |
| [`install`](./commands/install.md)         | Add a dependency or refresh the lockfile.                |
| [`remove`](./commands/remove.md)           | Drop a dependency and (optionally) its cached jar.       |
| [`info`](./commands/info.md)               | Inspect a Modrinth / Maven / file / workspace source.    |
| [`search`](./commands/search.md)           | Query Modrinth by keyword.                               |
| [`list`](./commands/list.md)               | Print declared deps, resolved versions, and registries.  |
| [`build`](./commands/build.md)             | Compile → resources → descriptor → shade → jar.          |
| [`test`](./commands/test.md)               | Compile and run JUnit Platform tests under `test/`.      |
| [`docs`](./commands/docs.md)               | Generate Javadoc HTML against the resolved classpath.    |
| [`dev`](./commands/dev.md)                 | Boot a live server with the plugin and its runtime deps. |
| [`doctor`](./commands/doctor.md)           | Validate the environment and every workspace.            |
| [`upgrade`](./commands/upgrade.md)         | Replace the running binary with the latest release.      |
| [`completions`](./commands/completions.md) | Print a shell completion script.                         |

## Deeper topics

- [Build pipeline](./build-pipeline.md): what happens between `pluggy build`
  and the output jar. Maven transitive resolution, SNAPSHOT handling,
  classpath construction, descriptor generation.
- [Dev server](./dev-server.md): the `dev/` staging directory, runtime vs
  compile plugin detection, EULA handling, `--reload` vs restart, shutdown
  semantics.
- [Workspaces](./workspaces.md): monorepo layout, inheritance rules, the
  `workspace:` source kind, topological build order.
- [IDE integration](./ide.md): what `ide: "vscode" | "eclipse" | "intellij"`
  writes and where.
- [Cross-platform notes](./cross-platform.md): install paths, cache paths,
  line endings, signal handling.
- [Troubleshooting](./troubleshooting.md): common failures, the error
  messages the code actually prints, and what to do about them.

## Recipes

Task-oriented walkthroughs for situations that come up often.

- [Adding a Paper plugin that uses adventure-api](./recipes/paper-with-adventure.md)
- [Testing a Paper plugin with MockBukkit](./recipes/testing-with-mockbukkit.md)
- [Setting up a monorepo with a shared API module](./recipes/monorepo-shared-api.md)
- [Upgrading across Paper major versions](./recipes/upgrade-paper-major.md)
- [CI builds without pluggy installed globally](./recipes/ci-without-global-pluggy.md)
- [Migrating from a Maven or Gradle plugin project](./recipes/migrating-from-maven-gradle.md)

## Reading conventions

Commands in this documentation that show paths use POSIX form
(`~/Library/Caches/pluggy/...`). Where the Windows path differs materially,
the difference is called out inline.

pluggy reads one file, `project.json`, and writes one lockfile, `pluggy.lock`.
Everything else (the cache, the build staging directory, the `dev/` server
directory) is derived.
