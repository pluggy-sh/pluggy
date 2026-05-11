# pluggy docs

pluggy is a self-contained toolchain for Minecraft plugin development. Scaffold a project, install dependencies from Modrinth, Maven, local jars, or sibling workspaces, build a real plugin jar, and boot a live Paper, Spigot, Velocity, or Sponge server that rebuilds when you save.

No global JVM toolchain, no Gradle wrapper, no `pom.xml`. One `project.json` per project.

## Start here

If you have never used pluggy before, read these in order. The first page is enough to get a plugin running.

- [Getting started](./getting-started.md): install, scaffold, build, and run a dev server. Eight minutes from zero to a live server.
- [Glossary](./glossary.md): plain-English definitions for every term in these docs. Bookmark it.
- [`project.json` reference](./project-json.md): every field, every form, and the validation rules.
- [Dependency sources](./dependencies.md): the Modrinth, Maven, file, and workspace grammar.

## Commands

Every subcommand, with its flags, JSON envelope, and sample output.

| Command                                    | Summary                                                  |
| ------------------------------------------ | -------------------------------------------------------- |
| [`init`](./commands/init.md)               | Scaffold a new project in an empty directory.            |
| [`install`](./commands/install.md)         | Add a dependency or refresh the lockfile.                |
| [`remove`](./commands/remove.md)           | Drop a dependency and (optionally) its cached jar.       |
| [`info`](./commands/info.md)               | Inspect a Modrinth, Maven, file, or workspace source.    |
| [`search`](./commands/search.md)           | Search Modrinth by keyword.                              |
| [`list`](./commands/list.md)               | Print declared deps, resolved versions, and registries.  |
| [`why`](./commands/why.md)                 | Trace which top-level dep pulled in a transitive.        |
| [`outdated`](./commands/outdated.md)       | List locked deps with a newer upstream version.          |
| [`audit`](./commands/audit.md)             | Verify cached jars against the lockfile hashes.          |
| [`build`](./commands/build.md)             | Compile, copy resources, write the descriptor, jar.      |
| [`test`](./commands/test.md)               | Compile and run JUnit Platform tests under `test/`.      |
| [`docs`](./commands/docs.md)               | Generate Javadoc HTML against the resolved classpath.    |
| [`dev`](./commands/dev.md)                 | Boot a live server with the plugin and its runtime deps. |
| [`sdk`](./commands/sdk.md)                 | Manage the JDKs pluggy provisions for builds.            |
| [`cache`](./commands/cache.md)             | Inspect and prune the download cache.                    |
| [`doctor`](./commands/doctor.md)           | Check the environment and every workspace.               |
| [`upgrade`](./commands/upgrade.md)         | Replace the running binary with the latest release.      |
| [`completions`](./commands/completions.md) | Print a shell completion script.                         |

## Deeper topics

These pages explain how pluggy works once you've outgrown the tutorial. They assume you've shipped at least one plugin.

- [Build pipeline](./build-pipeline.md): what happens between `pluggy build` and the output jar. Maven dependency resolution, SNAPSHOT handling, classpath construction, descriptor generation.
- [Dev server](./dev-server.md): the `dev/` staging directory, runtime vs compile-time plugin detection, EULA handling, `--reload` vs restart, shutdown semantics.
- [Workspaces](./workspaces.md): monorepo layout, inheritance rules, the `workspace:` source kind, topological build order.
- [IDE integration](./ide.md): what `ide: "vscode" | "eclipse" | "intellij"` writes and where.
- [Cross-platform notes](./cross-platform.md): install paths, cache paths, line endings, signal handling.
- [Troubleshooting](./troubleshooting.md): common failures, the error messages the code actually prints, and what to do about them.
- [Uninstalling](./uninstall.md): exact paths to remove for each install method, plus the cache and state directories.

## Recipes

Task-oriented walkthroughs for situations that come up often. Each recipe stands alone; pick the one that matches what you're trying to do.

- [Add a Paper plugin that uses adventure-api](./recipes/paper-with-adventure.md)
- [Test a Paper plugin with MockBukkit](./recipes/testing-with-mockbukkit.md)
- [Set up a monorepo with a shared API module](./recipes/monorepo-shared-api.md)
- [Upgrade across Paper major versions](./recipes/upgrade-paper-major.md)
- [Run CI builds without pluggy installed globally](./recipes/ci-without-global-pluggy.md)
- [Migrate from a Maven or Gradle plugin project](./recipes/migrating-from-maven-gradle.md)

## Reading these docs

Path examples use POSIX form (`~/Library/Caches/pluggy/...`). When the Windows path differs in a way that matters, the difference is called out inline.

pluggy reads one file (`project.json`) and writes one lockfile (`pluggy.lock`). Everything else, the cache, the build staging directory, the `dev/` server directory, is derived from those two.

If a term feels unfamiliar, check the [glossary](./glossary.md) first.
