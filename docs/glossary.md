# Glossary

Plain-English definitions for the terms pluggy's docs use most. Look here first when a word in another page feels unfamiliar.

The terms are sorted alphabetically. Each entry is one paragraph: what it means, and why pluggy talks about it.

## API

Short for "application programming interface." A set of classes and methods a server (Paper, Spigot, Velocity, Sponge) exposes so plugins can call into it. When pluggy installs `paper-api`, it's downloading the API for Paper so your plugin can compile against it.

## artifact

A single downloadable file, usually a `.jar`. Maven uses "artifact" to mean "the thing you're depending on." For pluggy, every dependency resolves to one artifact (a jar) plus optional transitive artifacts.

## BOM (Bill of Materials)

A special Maven artifact that lists versions for a family of related libraries so you don't have to pin each one yourself. Pluggy reads BOMs when resolving Maven dependencies so versions inside the family stay consistent.

## build

The process of turning your source files into a finished plugin jar. `pluggy build` runs the full [build pipeline](./build-pipeline.md): compile, copy resources, generate the descriptor, optionally shade, and zip.

## BuildTools

A program from the Spigot project that produces `spigot-api` and `bukkit-api` jars from Mojang's server. Pluggy runs BuildTools automatically when your project targets Spigot or Bukkit. The first run takes minutes; the result is cached.

## Bukkit / Spigot / Paper / Folia

Server flavours that share the same plugin format (`plugin.yml`). Bukkit was the original; Spigot is its descendant; Paper is a faster fork of Spigot; Folia is a multi-threaded fork of Paper. A plugin targeting any of these can usually run on the others.

## BungeeCord / Waterfall / Travertine

Proxy server flavours that route players between backend Minecraft servers. They share their own plugin format (`bungee.yml`) and are not interchangeable with Bukkit-family plugins.

## cache

A folder where pluggy stores files it has already downloaded so it doesn't fetch them twice. Lives at `~/Library/Caches/pluggy` (macOS), `~/.cache/pluggy` (Linux), or `%LOCALAPPDATA%\pluggy\cache` (Windows). Safe to delete; pluggy rebuilds it on the next command. Manage it with [`pluggy cache`](./commands/cache.md).

## class

The Java word for a self-contained unit of code. Every plugin has at least one class (its "main class") that the server loads when the plugin starts. Class names look like `com.example.shop.Main`.

## classpath

The list of jars Java looks in to find classes when it compiles or runs your code. Pluggy builds the classpath for you from your dependencies; you never write it by hand.

## compile

Turning Java source files (`.java`) into bytecode files (`.class`) so the server can run them. `pluggy build` runs the compiler (`javac`) for you.

## dependency

A library or other plugin your plugin uses. Pluggy resolves dependencies from four [sources](./dependencies.md): Modrinth, Maven, local files, and sibling workspaces.

## descriptor

The file Minecraft servers read to learn about your plugin: its name, version, main class, and so on. Bukkit-family servers read `plugin.yml`; BungeeCord reads `bungee.yml`; Velocity reads `velocity-plugin.json`; Sponge reads `META-INF/sponge_plugins.json`. Pluggy generates the right one from your `project.json`.

## descriptor family

A group of platforms that share the same descriptor. Paper, Spigot, Folia, and Bukkit all use `plugin.yml`, so they form one family. A single jar can target one family at a time. Mixing families means [splitting into workspaces](./workspaces.md#multi-family-monorepos).

## dev loop

The "save, see it run, save again" cycle. `pluggy dev` watches your files, rebuilds when you save, and restarts the server with your new jar.

## EULA

The Minecraft End User License Agreement. Mojang requires every server to accept it. `pluggy dev` writes the acceptance file for you so local development isn't interrupted; you're still bound by Mojang's terms.

## hardlink

A way to make one file appear in two places on disk without copying its bytes. Pluggy uses hardlinks to put cached jars into `dev/plugins/` so dev startup is instant. If hardlinks aren't possible (cross-disk), pluggy copies instead.

## integrity hash

A short string that uniquely identifies a file's contents. Pluggy stores a SHA-256 hash for every dependency in `pluggy.lock`. If the file ever changes, the hash won't match and pluggy refuses to use it. This is how pluggy makes sure the dependency you got today is the same one you got yesterday.

## javac

The Java compiler. It reads `.java` files and writes `.class` files. Pluggy invokes `javac` from the JDK it provisions for your project, so you don't need to install one.

## jar

A zip file containing compiled Java classes plus resources. Plugins ship as jars. The build pipeline produces one jar per workspace.

## JDK

Java Development Kit. The set of tools (including `javac`) needed to build Java code. Pluggy downloads the right JDK for your Minecraft version automatically. Manage it with [`pluggy sdk`](./commands/sdk.md).

## lockfile

`pluggy.lock` at the project root. Records the exact version and integrity hash of every resolved dependency, including transitives. Schema is flat: every dependency is one entry keyed by name, with `transitives: string[]` listing names of other entries it pulls in. Commit it to version control so every teammate and CI build uses the same dependency bytes.

## main class

The class the server loads when it starts your plugin. Set it as `main` in `project.json` (for example `com.example.shop.Main`).

## Maven

A long-standing Java build system, and also the most common public registry for Java libraries (Maven Central). Pluggy reads dependencies in Maven's coordinate format (`groupId:artifactId:version`) but doesn't ask you to write a `pom.xml`.

## Maven coordinate

The triple `groupId:artifactId:version` that uniquely names a Maven artifact. For example `net.kyori:adventure-api:4.17.0`.

## Modrinth

A Minecraft mod and plugin registry at [modrinth.com](https://modrinth.com). Pluggy installs Modrinth plugins by their slug: `pluggy install worldedit`.

## platform

The server flavour your plugin targets: `paper`, `spigot`, `bukkit`, `folia`, `velocity`, `waterfall`, `travertine`, or `sponge`. Set it in `project.json` under `compatibility.platforms`.

## plugin

A jar that adds features to a Minecraft server when the server loads it from `plugins/`. The thing pluggy helps you build.

## POM

A Maven project file (`pom.xml`). Pluggy reads POMs while resolving Maven dependencies so it can find each artifact's own dependencies. You don't write one yourself.

## registry

A server that hosts dependency artifacts. Maven Central is one registry; PaperMC's Maven repo is another; private GitHub Packages registries are common in companies. Configure them under `registries` in `project.json`.

## resolver

The part of pluggy that turns "I need worldedit" into "download this exact `.jar` from this URL." There's one resolver per source kind (Modrinth, Maven, file, workspace).

## shade

To copy classes from a dependency jar into your plugin jar so the plugin runs even when the server doesn't provide that library. Configure shading per dependency under `shading` in `project.json`.

## SHA-256

A standard way to compute a short fingerprint for a file. Pluggy uses SHA-256 for every integrity hash.

## SIGINT / SIGTERM / SIGKILL

Operating-system signals used to stop a running program. SIGINT is what Ctrl+C sends and asks the program to exit cleanly. SIGTERM is similar but stronger. SIGKILL ends the program immediately and gives it no chance to save state. Pluggy's dev server walks this ladder when you press Ctrl+C.

## slug

A short URL-safe name for a Modrinth project, like `worldedit` or `essentialsx`. The text after `/plugin/` in a Modrinth URL is the slug.

## SNAPSHOT

A Maven version that ends with `-SNAPSHOT`. SNAPSHOTs are rebuilt continuously by their authors, so the file behind a SNAPSHOT version can change. Pluggy refetches SNAPSHOTs on every install; pinned versions like `1.0.0` are cached forever.

## source kind

How a dependency is hosted: `modrinth`, `maven`, `file`, or `workspace`. Each has its own grammar, documented in [Dependencies](./dependencies.md).

## stage / staging directory

A scratch folder pluggy uses while building. Lives at `<workspace>/.pluggy-build/<hash>/`. Gets reused between builds for incremental compilation; `--clean` wipes it.

## state directory

A folder for pluggy's own bookkeeping (like the daily update-check timestamp). Separate from the cache because it shouldn't be wiped when you clear caches. Lives at `~/Library/Application Support/pluggy` (macOS), `$XDG_STATE_HOME/pluggy` (Linux), or `%APPDATA%\pluggy` (Windows).

## topological order

The order in which workspaces must be built so that every workspace's dependencies are built before it. Pluggy computes this for you when you run `pluggy build` at the repo root.

## transitive dependency

A dependency of a dependency. If your plugin depends on `adventure-api`, and `adventure-api` depends on `adventure-key`, then `adventure-key` is a transitive dependency. Pluggy resolves the full chain (the "transitive closure") and locks every entry.

## Velocity

A modern Minecraft proxy server with its own plugin format (`velocity-plugin.json`). Sits in front of backend servers and routes players. Plugins for Velocity don't run on Bukkit-family servers and vice versa.

## workspace

One buildable plugin project. The simplest pluggy repo has one workspace at the root. Larger repos can have many workspaces, each with its own `project.json` and jar. See [Workspaces](./workspaces.md).
