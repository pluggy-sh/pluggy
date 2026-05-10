# Getting started

By the end of this guide you'll have a working Minecraft plugin running on a live server, with one extra plugin (WorldEdit) installed. The whole walkthrough takes about eight minutes and assumes nothing about Java, Maven, or Gradle.

If a word here feels unfamiliar, check the [glossary](./glossary.md).

## Before you start

You need:

- An internet connection for the first run. pluggy downloads the right Java version for your project the first time you build, and caches it for next time.
- About 200 MB of disk space for that cache.
- A code editor. Anything works, but VS Code, IntelliJ, and Eclipse get extra integration from pluggy.

You do not need a [JDK](./glossary.md#jdk) installed. If you already have one, set `JAVA_HOME` and pluggy will reuse it when its major version matches your project. The cache lives at:

| OS      | Path                                                   |
| ------- | ------------------------------------------------------ |
| macOS   | `~/Library/Caches/pluggy/`                             |
| Linux   | `$XDG_CACHE_HOME/pluggy/` (default `~/.cache/pluggy/`) |
| Windows | `%LOCALAPPDATA%\pluggy\cache\`                         |

Manage it later with [`pluggy cache`](./commands/cache.md) or [`pluggy sdk`](./commands/sdk.md).

## Install pluggy

### macOS and Linux

Run the install script:

```bash
curl -fsSL https://pluggy.sh/install.sh | sh
```

The script downloads the binary for your operating system into `~/.pluggy/bin/pluggy` and adds that directory to your `PATH` by appending an `export` line to your shell profile (`~/.zshrc`, `~/.bashrc`, `~/.bash_profile`, `~/.profile`, or `~/.config/fish/config.fish`, whichever exist). It does not need `sudo`.

To put pluggy somewhere else, set `PLUGGY_HOME`:

```bash
PLUGGY_HOME=/opt/pluggy curl -fsSL https://pluggy.sh/install.sh | sh
```

Open a new terminal, or run `source` on the profile that was updated, to pick up the new `PATH` in your current session.

### Windows

Open PowerShell and run:

```powershell
irm https://pluggy.sh/install.ps1 | iex
```

The script puts `pluggy.exe` at `%LOCALAPPDATA%\Programs\pluggy` and appends that directory to your user `PATH`. It does not need administrator rights. Restart your terminal before using `pluggy`.

### Verify

```text
$ pluggy -V
0.1.0
```

If the version prints, you're set. If the command isn't found, your terminal is probably still using the old `PATH`. Open a fresh terminal and try again.

## Scaffold your first plugin

Pick an empty directory and run `init`:

```bash
mkdir my-plugin && cd my-plugin
pluggy init --yes --name my_plugin --main com.example.myplugin.Main
```

`init` writes three files:

- `project.json`: the only config file pluggy reads.
- `src/com/example/myplugin/Main.java`: a starter [main class](./glossary.md#main-class) with empty `onEnable` and `onDisable` methods.
- `src/config.yml`: a starter resources file. The `${project.name}` placeholders inside are replaced when pluggy builds.

Two rules on the names you pass:

- `--name` must match `[a-zA-Z0-9_-]+`. Letters, numbers, underscores, and hyphens, nothing else.
- `--main` must be a dotted Java class path with at least a package and a class (`com.example.myplugin.Main`).

Without `--yes` pluggy prompts you interactively. Prompts are skipped automatically when the target directory is empty or when `--json` is set.

Take a look at what you got:

```text
$ cat project.json
{
  "name": "my_plugin",
  "version": "1.0.0",
  "description": "A simple Minecraft plugin",
  "main": "com.example.myplugin.Main",
  "compatibility": {
    "versions": ["1.21.8"],
    "platforms": ["paper"]
  }
}
```

The Minecraft version comes from Paper's published list. pluggy picks the highest version every selected platform supports. Pin a different one with `--mc-version 1.21.8` at `init` time. (`--version` sets the plugin's own `project.version`, which is a separate field.)

The first `pluggy build` derives the right Java major from this Minecraft version (Java 21 for 1.20.5 and later, Java 17 for 1.18 to 1.20.4, and so on) and downloads a matching Temurin JDK if one isn't already on `JAVA_HOME` or in the cache. Override the choice with [`pluggy sdk use`](./commands/sdk.md#use), or by adding a [`jdk` block](./project-json.md#jdk-optional) to `project.json`.

## Add a dependency

Install a plugin from [Modrinth](./glossary.md#modrinth):

```text
$ pluggy install worldedit
✓ Installed worldedit into my_plugin (1 resolved)
```

pluggy rewrites `project.json` to record the dependency:

```json
"dependencies": {
  "worldedit": {
    "source": "modrinth:worldedit",
    "version": "7.3.15"
  }
}
```

It also writes `pluggy.lock` at the project root with the resolved version, its [SHA-256 integrity hash](./glossary.md#integrity-hash), and the full chain of [transitive dependencies](./glossary.md#transitive-dependency) (empty for Modrinth plugins; populated for Maven artifacts).

You can install dependencies in four shapes. The full grammar is documented in [Dependency sources](./dependencies.md), but the short version is:

- `worldedit`: latest stable version from Modrinth.
- `worldedit@7.3.15`: a specific Modrinth version.
- `./libs/my-lib.jar`: a local jar. pluggy identifies it by its content hash.
- `maven:net.kyori:adventure-api@4.17.0`: a Maven artifact. Needs at least one entry in `registries` if it isn't on Maven Central.

## Run the dev server

Start a live server with `dev`:

```text
$ pluggy dev
[server output streams here]
```

`pluggy dev` runs a full build, downloads the matching Paper server jar, sets up a `dev/` directory next to your project, writes `eula.txt` accepting Mojang's [EULA](./glossary.md#eula) on your behalf (suppress with `PLUGGY_DEV_NO_EULA=1`), and runs `java -jar server.jar` with your plugin and any runtime plugin dependencies linked into `dev/plugins/`.

When you save a `.java` file, pluggy waits 200 milliseconds (so saving multiple files at once still triggers one rebuild), rebuilds the jar, sends `stop` to the server, swaps in the new jar, and starts a fresh server. Pass `--reload` to use Bukkit's `/reload confirm` instead of a full restart. It's faster, but Bukkit's own docs warn that `/reload` is unreliable for plugins that hold state between reloads.

Press Ctrl+C once for a graceful shutdown (30 seconds of grace). A second Ctrl+C within 2 seconds force-kills the server.

## Build for release

When you're ready to ship a jar, run:

```text
$ pluggy build
Building my_plugin
✓ my_plugin → /Users/you/my-plugin/bin/my_plugin-1.0.0.jar (142.4 KB, 3821ms)
```

The output jar lives at `<workspace>/bin/<name>-<version>.jar` by default. Override with `--output path/to/out.jar`.

## What pluggy did under the hood

If you're curious about what `pluggy build` actually does, here's the short version. The full walkthrough lives in the [build pipeline](./build-pipeline.md) page.

- Looked up the platform `paper` in pluggy's platform registry. Each platform exposes a Maven coordinate for its API. For Paper, that's `io.papermc.paper:paper-api` from the PaperMC Maven repo.
- Downloaded the `paper-api` jar and put it on the compile [classpath](./glossary.md#classpath).
- Resolved every entry in `dependencies`, downloading jars into the cache. Maven dependencies also had their POMs parsed for transitives.
- Provisioned a JDK matching `compatibility.versions[0]`'s Java requirement (Java 21 for 1.21.8) into `~/Library/Caches/pluggy/jdk/temurin-21-...`. Later builds skip the download.
- Ran `<cached-jdk>/bin/javac -encoding UTF-8 -d <staging> -cp <classpath> <sources>`.
- Ran `src/config.yml` through the `${project.x}` template substitution and wrote it into the staging directory.
- Generated `plugin.yml` from `project.name`, `version`, `main`, `description`, and the derived `api-version` (`"1.21"` for `1.21.8`).
- Zipped the staging directory into the output jar.

Each step lives in its own module under `src/build/`.

## What you just learned

You now know how to:

- Install pluggy and verify it.
- Scaffold a new plugin with `pluggy init`.
- Add a dependency with `pluggy install`.
- Run a live server with `pluggy dev`.
- Ship a jar with `pluggy build`.

That covers most days of plugin development.

## Next steps

- Speed up the dev loop: [`pluggy dev`](./commands/dev.md) reference.
- Add JUnit tests: [`pluggy test`](./commands/test.md).
- Split into multiple plugins: [Workspaces](./workspaces.md).
- Bundle a third-party library into your jar: [Shading](./project-json.md#shading-optional).
- Set up your editor: [IDE integration](./ide.md).
- Wire up CI without installing pluggy globally: [CI recipe](./recipes/ci-without-global-pluggy.md).
