# Your first monorepo

By the end of this tutorial you'll have one repository with two plugin projects in it: a `core` workspace that publishes a shared interface, and a `plugin` workspace that consumes it. You'll build both with one command and learn the shape of the [`workspace:`](./glossary.md#workspace) dependency that ties them together.

This is the smallest useful monorepo. For a full multi-module layout with shading and addons, see the [shared-API recipe](./recipes/monorepo-shared-api.md). For the underlying reference, see [Workspaces](./workspaces.md).

If a word here feels unfamiliar, check the [glossary](./glossary.md).

## When you'd want this

A single plugin is one `project.json` at the repo root. You don't need a monorepo unless one of the following is true:

- Two plugins want to share Java types (an `api` module).
- You ship a Paper plugin and a Velocity plugin in one repository.
- You manage a family of plugins that release on their own cadence.

For anything else, stay with one plugin. You can always split later.

## Create the layout

```text
my-network/
├── project.json          (root, not buildable)
├── core/
│   ├── project.json
│   └── src/com/example/core/Greeter.java
└── plugin/
    ├── project.json
    └── src/com/example/plugin/Main.java
```

From an empty directory:

```bash
mkdir -p my-network/core/src/com/example/core
mkdir -p my-network/plugin/src/com/example/plugin
cd my-network
```

## The root project.json

The root tells pluggy where the workspaces live. It doesn't build anything itself; it has no `main`.

Write `project.json`:

```json
{
  "name": "my_network",
  "version": "0.0.0",
  "compatibility": {
    "versions": ["1.21.8"],
    "platforms": ["paper"]
  },
  "workspaces": ["core", "plugin"]
}
```

The `compatibility` block here is inherited by both workspaces, so neither has to repeat it. Paths in `workspaces` are forward-slashed and relative to the repo root.

## The core workspace

`core` publishes a single interface that the plugin will use. It's a real plugin from pluggy's point of view, but it doesn't have to do anything at runtime.

Write `core/project.json`:

```json
{
  "name": "core",
  "version": "1.0.0",
  "main": "com.example.core.CorePlugin"
}
```

Write `core/src/com/example/core/Greeter.java`:

```java
package com.example.core;

public interface Greeter {
    String greet(String name);
}
```

Write `core/src/com/example/core/CorePlugin.java`:

```java
package com.example.core;

import org.bukkit.plugin.java.JavaPlugin;

public class CorePlugin extends JavaPlugin {}
```

`CorePlugin` exists because `main` is required for every buildable workspace. It produces a loadable jar even though it has no behaviour of its own.

## The plugin workspace

`plugin` depends on `core` through the `workspace:` source kind. At resolve time, pluggy points at `core`'s built jar so the compiler can find the `Greeter` interface.

Write `plugin/project.json`:

```json
{
  "name": "plugin",
  "version": "1.0.0",
  "main": "com.example.plugin.Main",
  "dependencies": {
    "core": {
      "source": "workspace:core",
      "version": "*"
    }
  }
}
```

The `version` field is ignored for `workspace:` deps; `core`'s own `project.json:version` is authoritative. Use `"*"` as the conventional placeholder.

Write `plugin/src/com/example/plugin/Main.java`:

```java
package com.example.plugin;

import com.example.core.Greeter;
import net.kyori.adventure.text.Component;
import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;
import org.bukkit.event.player.PlayerJoinEvent;
import org.bukkit.plugin.java.JavaPlugin;

public class Main extends JavaPlugin implements Listener, Greeter {
    @Override
    public void onEnable() {
        getServer().getPluginManager().registerEvents(this, this);
    }

    @Override
    public String greet(String name) {
        return "Hi, " + name + ", welcome to my-network.";
    }

    @EventHandler
    public void onPlayerJoin(PlayerJoinEvent event) {
        event.joinMessage(Component.text(greet(event.getPlayer().getName())));
    }
}
```

The plugin implements `Greeter` (from `core`) and uses it on player join.

## Build both at once

From the repo root:

```text
$ pluggy build
build core
✓ core: /Users/you/my-network/core/bin/core-1.0.0.jar (1.1 KB, 1701ms)
build plugin
✓ plugin: /Users/you/my-network/plugin/bin/plugin-1.0.0.jar (2.4 KB, 1812ms)
```

pluggy sorted the two workspaces topologically. `core` builds first because `plugin` depends on it; `plugin` builds second against the just-built `core-1.0.0.jar`.

If you'd run `pluggy build` from inside `plugin/` before ever building `core`, pluggy would have stopped with a clear error:

```text
shade: workspace dependency "core" has not been built yet, expected jar at "/Users/you/my-network/core/bin/core-1.0.0.jar". Build the sibling workspace first.
```

Running from the root is the simplest way to avoid that. You can also build a single workspace and its prerequisites explicitly with `pluggy build --workspace plugin` at the root.

## Run the dev server

`pluggy dev` runs one server at a time, so you pick a workspace:

```bash
cd plugin
pluggy dev
```

(`pluggy dev --workspace plugin` from the root works too.)

The server loads `plugin`'s jar only. `core` lives on `plugin`'s classpath because `plugin` depends on it, so the `Greeter` types are available at runtime, but `core` itself isn't installed as a separate plugin. That's normal: in this layout `core` is a library, not a plugin you'd run on its own.

Connect to `localhost` from Minecraft and you'll see your greeting in chat.

## What you just learned

- A monorepo is just multiple `project.json` files pointed at from a root that lists them in `workspaces`.
- One workspace depends on another with `"source": "workspace:<name>"`.
- `pluggy build` at the root respects the dependency graph; a workspace builds after its prerequisites.

## Next steps

- Bundle `core`'s classes into `plugin`'s jar so you can ship one file: [Shading](./project-json.md#shading-optional).
- Add an addon that consumes `core` without depending on `plugin`: [shared-API recipe](./recipes/monorepo-shared-api.md).
- Ship a Paper plugin and a Velocity plugin in one repo: [Multi-family monorepos](./workspaces.md#multi-family-monorepos).
- Inspect the workspace graph: [`pluggy graph`](./commands/graph.md).
- See the full workspace reference for inheritance, opt-outs, and selection flags: [Workspaces](./workspaces.md).
