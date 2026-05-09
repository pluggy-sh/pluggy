# Getting started

Install pluggy, scaffold a Paper plugin, add a dependency, and run it on a
live server. Eight minutes start to finish.

## Prerequisites

- An internet connection for the first run. pluggy provisions the right
  JDK for your project from the [Foojay Disco API](https://api.foojay.io/disco/v3.0/distributions)
  on first build, and caches it under `~/Library/Caches/pluggy` on macOS,
  `$XDG_CACHE_HOME/pluggy` on Linux, and `%LOCALAPPDATA%\pluggy\cache` on
  Windows.

You don't need a pre-installed JDK. Set `JAVA_HOME` if you want pluggy to
reuse an existing toolchain (asdf, mise, hand-installed Temurin) when its
major matches the project. See [`pluggy sdk`](./commands/sdk.md) for cache
management and CI patterns.

pluggy ships as a native binary. Bun is only required if you want to build
pluggy itself from source.

## Install

### macOS and Linux

```bash
curl -fsSL https://github.com/pluggy-sh/pluggy/releases/latest/download/install.sh | bash
```

The script downloads the binary for your OS and architecture into
`~/.pluggy/bin/pluggy` and adds that directory to your `PATH` via your
shell profile (`~/.zshrc`, `~/.bashrc`, `~/.bash_profile`,
`~/.profile`, `~/.config/fish/config.fish`, whichever exist). No
`sudo` required.

Override the install location with `PLUGGY_HOME`:

```bash
PLUGGY_HOME=/opt/pluggy curl -fsSL https://github.com/pluggy-sh/pluggy/releases/latest/download/install.sh | bash
```

Open a new shell or `source` the updated profile to pick up the new
`PATH` in your current session.

### Windows

```powershell
irm https://github.com/pluggy-sh/pluggy/releases/latest/download/install.ps1 | iex
```

The script installs `pluggy.exe` to `%LOCALAPPDATA%\Programs\pluggy` and
appends that directory to your user `PATH`. No administrator privileges
required. Restart your terminal before using the command.

### Verify

```text
$ pluggy -V
0.1.0
```

## Scaffold a project

```bash
mkdir my-plugin && cd my-plugin
pluggy init --yes --name my_plugin --main com.example.myplugin.Main
```

`init` writes three files:

- `project.json`: the only config file pluggy reads.
- `src/com/example/myplugin/Main.java`: a Bukkit `JavaPlugin` with stubbed
  `onEnable` / `onDisable` methods.
- `src/config.yml`: a resources file with `${project.name}` placeholders
  rendered at build time.

The project name must match `[a-zA-Z0-9_-]+` (alphanumeric, underscores,
and hyphens). The `--main` value must be a dotted Java class path,
minimum package + class.

Without `--yes` pluggy prompts interactively; confirmations are skipped when
the target directory is empty or when `--json` is set.

Inspect what you got:

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

The `compatibility.versions[0]` entry is picked up from the Paper upstream
at init time. It's the highest release available on every selected
platform. Pin this by passing `--mc-version 1.21.8` to `init` if you
need a specific version. (`--version` sets the plugin's own
`project.version`. They're separate knobs.)

The first `pluggy build` derives the required Java major from this version
(Java 21 for 1.20.5+, Java 17 for 1.18-1.20.4, and so on) and downloads a
matching Temurin JDK if one isn't already on `JAVA_HOME` or in the cache.
Override the choice with [`pluggy sdk use`](./commands/sdk.md#use) or by
adding a [`jdk` block](./project-json.md#jdk-optional) to `project.json`.

## Add a dependency

Install a plugin from Modrinth.

```text
$ pluggy install worldedit
Installed worldedit into my_plugin (1 resolved).
```

pluggy rewrites `project.json` to add the dep in long form:

```json
"dependencies": {
  "worldedit": {
    "source": "modrinth:worldedit",
    "version": "7.3.15"
  }
}
```

It also writes `pluggy.lock` at the project root with the resolved version,
its SHA-256 integrity, and the full transitive closure (empty for Modrinth
plugins; populated for Maven artifacts).

The dep identifier grammar is documented in
[Dependency sources](./dependencies.md). In short:

- `worldedit`: latest stable from Modrinth.
- `worldedit@7.3.15`: a specific Modrinth version.
- `./libs/my-lib.jar`: a local file. pluggy content-addresses it.
- `maven:net.kyori:adventure-api@4.17.0`: a Maven artifact. Requires at
  least one entry in `registries` (see below).

## Run the dev server

```text
$ pluggy dev
dev: starting my_plugin
```

`pluggy dev` runs a full build, downloads the Paper server jar for the
version in `compatibility.versions[0]`, stages a `dev/` directory next to
your project, writes `eula.txt` accepting Mojang's EULA on your behalf
(suppressed with `PLUGGY_DEV_NO_EULA=1`), and spawns `java -jar server.jar`
with your plugin and any runtime plugin deps hardlinked into `dev/plugins/`.

When you save a `.java` file, pluggy debounces the event for 200ms,
rebuilds, sends `stop\n` to the server's stdin, waits for it to exit, swaps
in the new jar, and spawns a fresh server. Pass `--reload` to use Bukkit's
`/reload confirm` instead of a full restart (faster, but Bukkit's own docs
warn that `/reload` is unreliable for stateful plugins).

Press Ctrl+C once for graceful shutdown (30 seconds grace). A second Ctrl+C
within 2 seconds sends SIGKILL.

## Build for release

```text
$ pluggy build
build my_plugin
✔ my_plugin: /Users/you/my-plugin/bin/my_plugin-1.0.0.jar (142.4 KB, 3821ms)
```

The output jar lives at `<workspace>/bin/<name>-<version>.jar` by default.
Override with `--output path/to/out.jar`.

## What pluggy did under the hood

- Resolved `compatibility.platforms[0]` (`paper`) against the platform
  registry. Each platform exposes a Maven API spec. For Paper, that's
  `io.papermc.paper:paper-api` from the PaperMC maven repo.
- Downloaded the `paper-api` jar and put it on the compile classpath.
- Resolved every `dependencies[]` entry, downloading jars into
  `~/Library/Caches/pluggy/dependencies/<kind>/...`. Maven deps also had
  their POM parsed for transitives.
- Provisioned a JDK matching `compatibility.versions[0]`'s Java
  requirement (Java 21 for 1.21.8) into
  `~/Library/Caches/pluggy/jdk/temurin-21-...`. Subsequent builds skip the
  download.
- Ran `<cached-jdk>/bin/javac -encoding UTF-8 -d <staging> -cp <classpath> <sources>`.
- Copied `src/config.yml` through the `${project.x}` templater and wrote
  it to `config.yml` inside the staging dir.
- Generated `plugin.yml` from `project.name`, `version`, `main`,
  `description`, and the derived `api-version` (`"1.21"` for `1.21.8`).
- Zipped the staging dir into the output jar.

Each step lives in a dedicated module under `src/build/`. See
[Build pipeline](./build-pipeline.md) for the full walkthrough.

## Where to go next

- Make the dev loop faster: [`pluggy dev`](./commands/dev.md).
- Add JUnit tests: [`pluggy test`](./commands/test.md).
- Split into a monorepo: [Workspaces](./workspaces.md).
- Ship a jar that bundles a third-party library: [Shading](./project-json.md#shading).
- Set up IDE integration: [IDE integration](./ide.md).
- Wire up CI without installing pluggy globally: [CI recipe](./recipes/ci-without-global-pluggy.md).
