# Your first plugin

By the end of this tutorial your plugin will greet every player when they join the server, and you'll know the basic loop of edit → save → see it in-game. It assumes you've finished [Getting started](./getting-started.md), so `pluggy init` has already scaffolded a project with an empty `Main.java`.

If a word here feels unfamiliar, check the [glossary](./glossary.md).

## What you have right now

After `pluggy init`, your project looks like this:

```text
my-plugin/
├── project.json
├── pluggy.lock
└── src/
    ├── config.yml
    └── com/example/myplugin/Main.java
```

`Main.java` already extends `JavaPlugin`, the base class every Bukkit-style plugin uses. Its `onEnable` method is empty. The plugin loads, but does nothing.

```java
package com.example.myplugin;

import org.bukkit.plugin.java.JavaPlugin;

public class Main extends JavaPlugin {
    @Override
    public void onEnable() {}

    @Override
    public void onDisable() {}
}
```

The next step is to make it react to something happening on the server.

## React to a player joining

Paper, Spigot, and Bukkit all expose events: a player joins, a block breaks, a chat message is sent. Your plugin handles an event by:

1. Implementing the marker interface `Listener`.
2. Annotating a method with `@EventHandler` and accepting the event class as its single argument.
3. Registering the listener with the plugin manager when the plugin starts.

Replace the contents of `Main.java` with:

```java
package com.example.myplugin;

import net.kyori.adventure.text.Component;
import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;
import org.bukkit.event.player.PlayerJoinEvent;
import org.bukkit.plugin.java.JavaPlugin;

public class Main extends JavaPlugin implements Listener {
    @Override
    public void onEnable() {
        getServer().getPluginManager().registerEvents(this, this);
    }

    @EventHandler
    public void onPlayerJoin(PlayerJoinEvent event) {
        Component greeting = Component.text(
            "Welcome to the server, " + event.getPlayer().getName() + "!"
        );
        event.joinMessage(greeting);
    }
}
```

A few things worth knowing about that code:

- `Component` is Paper's modern text type, from the bundled Kyori Adventure library. You don't need to install it, Paper ships it.
- `event.joinMessage(...)` overwrites the default "Player joined the game" message for this join.
- `getServer().getPluginManager().registerEvents(this, this)` registers `Main` (which now implements `Listener`) with the plugin manager so the `@EventHandler` method gets called.

## See it in-game

Start the dev server. The first run downloads a Paper server jar and accepts Mojang's [EULA](./glossary.md#eula) on your behalf:

```bash
pluggy dev
```

Once the server prints `Done (...)! For help, type "help"`, open Minecraft, click **Multiplayer**, **Direct Connect**, and connect to `localhost`. (Offline mode is on by default in `dev`, so any account works.)

You should see your greeting in chat as you spawn:

```text
Welcome to the server, Notch!
```

## The edit loop

Leave `pluggy dev` running and change the greeting in your editor:

```java
Component greeting = Component.text(
    "Hello, " + event.getPlayer().getName() + ", glad you're here."
);
```

Save. pluggy debounces 200 ms, rebuilds the jar, swaps it in, and restarts the server. Reconnect from the Minecraft client and you'll see the new message. This is the tight loop: write code, save, see it work.

Press Ctrl+C in the terminal once to stop the server gracefully. A second Ctrl+C within two seconds force-kills it.

## What's actually shipping

Run `pluggy build` to produce a release jar:

```text
$ pluggy build
Building my_plugin
✓ my_plugin → /Users/you/my-plugin/bin/my_plugin-1.0.0.jar (4.5 KB, 2103ms)
```

The jar contains:

- Your compiled `Main.class`.
- An auto-generated `plugin.yml` derived from `project.json`.
- The `config.yml` file `init` scaffolded.

No Adventure jar, no Paper jar. Paper ships those at runtime, so bundling them would just be duplicated bytes on disk and unpredictable class loading.

## Next steps

You've written a plugin that reacts to a real Minecraft event. From here, common next moves:

- Add a slash command. The auto-generated `plugin.yml` doesn't model `commands:`, so override it with a hand-written one through [`project.resources`](./project-json.md#resources-optional).
- Read a configuration value. Your scaffold's `src/config.yml` is already shipped into the jar; load it with `getConfig().getString("key")` in `onEnable`.
- Handle more events. Paper's API exposes events for every server-side action; see the [Paper docs](https://docs.papermc.io/paper/dev/getting-started/paper-plugins) for the full list.
- Pull in a third-party library: [adding adventure-api](./recipes/paper-with-adventure.md), or browse the rest of the [recipes](./recipes/).
- Split into multiple plugins that share code: [Your first monorepo](./your-first-monorepo.md).
- Add JUnit tests: [`pluggy test`](./commands/test.md).
