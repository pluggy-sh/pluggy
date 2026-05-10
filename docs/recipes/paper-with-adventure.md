# Adding a Paper plugin that uses adventure-api

Paper bundles Kyori Adventure's API (the modern text and chat library) at runtime, but you still need it on the compile [classpath](../glossary.md#classpath). This recipe walks through adding it to a pluggy project without [shading](../glossary.md#shade) it. Paper provides Adventure at runtime, so you just need it at compile time.

## Start with a fresh Paper project

```bash
mkdir chat-plugin && cd chat-plugin
pluggy init --yes --name chat_plugin --main com.example.chat.ChatPlugin --platform paper
```

## Pin the Minecraft version

Open `project.json` and confirm `compatibility.versions[0]`. pluggy pulled the latest from Paper's upstream, but you might want to pin something older.

```json
{
  "name": "chat_plugin",
  "version": "1.0.0",
  "main": "com.example.chat.ChatPlugin",
  "compatibility": {
    "versions": ["1.21.8"],
    "platforms": ["paper"]
  }
}
```

## Add a registry for Maven Central

`adventure-api` is on Maven Central. Maven Central is appended automatically by pluggy, but if you want to make the dependency on it explicit, declare it in `registries`:

```json
{
  "...": "...",
  "registries": ["https://repo1.maven.org/maven2/"]
}
```

You don't need to declare the PaperMC Maven repo. pluggy prepends that automatically when it resolves `paper-api`.

## Install adventure-api

```bash
pluggy install maven:net.kyori:adventure-api@4.17.0
```

`project.json` now has:

```json
"dependencies": {
  "adventure-api": {
    "source": "maven:net.kyori:adventure-api",
    "version": "4.17.0"
  }
}
```

`pluggy.lock` records `adventure-api` plus its [transitive dependencies](../glossary.md#transitive-dependency) (mostly `adventure-key`, `examination-api`, and a JSR-305 annotations jar). pluggy resolves all of them from Maven Central.

## Use it in your code

Open `src/com/example/chat/ChatPlugin.java` and import Adventure:

```java
package com.example.chat;

import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.format.NamedTextColor;
import org.bukkit.plugin.java.JavaPlugin;

public class ChatPlugin extends JavaPlugin {
    @Override
    public void onEnable() {
        getServer().sendMessage(
            Component.text("Chat plugin enabled", NamedTextColor.GREEN)
        );
    }
}
```

## Build

```text
$ pluggy build
build chat_plugin
✓ chat_plugin: /.../bin/chat_plugin-1.0.0.jar (4.2 KB, 1923ms)
```

Notice the output jar is small (kilobytes, not megabytes). That's because pluggy didn't shade Adventure. Paper already ships it. Your jar contains just your compiled classes plus `plugin.yml` and `config.yml`.

## About shading

If you were targeting a server that doesn't ship Adventure (plain Bukkit, for example), you'd bundle it:

```json
{
  "dependencies": {
    "adventure-api": { "source": "maven:net.kyori:adventure-api", "version": "4.17.0" }
  },
  "shading": {
    "adventure-api": {
      "include": ["net/kyori/adventure/**"]
    }
  }
}
```

That's not what you want for Paper. Two copies of Adventure on the classpath (yours and Paper's) will load classes unpredictably. For Paper, never shade Adventure.

## Run the dev server

```bash
pluggy dev
```

pluggy downloads the Paper server jar, writes `dev/eula.txt`, builds
your plugin, drops it into `dev/plugins/`, and spawns the server. Open
the game, point it at `localhost:25565` (offline mode is on by default),
and watch your plugin announce itself in chat.

## What's on the classpath

Use `pluggy list --tree` to see the full chain of dependencies pluggy resolved:

```text
$ pluggy list --tree
standalone: chat_plugin

dependencies:
  └── adventure-api  @4.17.0 → 4.17.0  maven:net.kyori:adventure-api
      ├── adventure-key  @4.17.0 → 4.17.0  maven:net.kyori:adventure-key
      ├── examination-api  @1.3.0 → 1.3.0  maven:net.kyori:examination-api
      └── jsr305  @3.0.2 → 3.0.2  maven:com.google.code.findbugs:jsr305

registries:
  └── https://repo1.maven.org/maven2/
```

Paper's `paper-api` jar is also on the compile classpath at build time but doesn't appear in `pluggy list` because it's not in `project.json`. pluggy adds it from the platform registry during `build`.

## See also

- [Dependencies](../dependencies.md): the source-string grammar.
- [project.json shading](../project-json.md#shading-optional): the shading options in detail.
- [Dev server](../dev-server.md): what `pluggy dev` does.
