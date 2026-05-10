# Setting up a monorepo with a shared API module

A common pattern for larger plugin projects: one `api` module that exposes types and interfaces, one `impl` module that implements them, and an addon or two that consume the api. Everything in one repo, one lockfile, one command to build them all. The pluggy term for this layout is [workspaces](../glossary.md#workspace).

## Layout

```text
my-network/
├── project.json            (root: paper compat, no main, no build)
├── pluggy.lock             (shared)
├── api/
│   ├── project.json
│   └── src/com/example/api/
│       └── StoreService.java
├── impl/
│   ├── project.json
│   └── src/com/example/impl/
│       └── ImplPlugin.java
└── addons/
    └── shop/
        ├── project.json
        └── src/com/example/shop/
            └── ShopAddon.java
```

## The root `project.json`

```json
{
  "name": "my_network",
  "version": "0.0.0",
  "description": "Example network plugin family",
  "authors": ["Alice"],
  "compatibility": {
    "versions": ["1.21.8"],
    "platforms": ["paper"]
  },
  "registries": ["https://repo1.maven.org/maven2/"],
  "workspaces": ["api", "impl", "addons/shop"]
}
```

No `main`. The root isn't buildable in its own right. It's a container for workspaces.

`compatibility`, `authors`, `description`, and `registries` are inherited by any workspace that doesn't declare its own.

## The `api` workspace

This one has no dependencies. It exports types.

```json
{
  "name": "api",
  "version": "1.0.0",
  "main": "com.example.api.ApiPlugin"
}
```

`src/com/example/api/StoreService.java`:

```java
package com.example.api;

public interface StoreService {
    int getBalance(java.util.UUID playerId);
    void setBalance(java.util.UUID playerId, int value);
}
```

`src/com/example/api/ApiPlugin.java`:

```java
package com.example.api;

import org.bukkit.plugin.java.JavaPlugin;

public class ApiPlugin extends JavaPlugin {
    // Empty: this workspace just publishes the API type.
    // A real api workspace might register a service via Bukkit's ServicesManager.
}
```

## The `impl` workspace

Depends on `api`. Shading is optional. We'll shade it here so `impl` is a standalone jar with the interfaces inside.

```json
{
  "name": "impl",
  "version": "1.0.0",
  "main": "com.example.impl.ImplPlugin",
  "dependencies": {
    "api": {
      "source": "workspace:api",
      "version": "*"
    }
  },
  "shading": {
    "api": {
      "include": ["com/example/api/**"]
    }
  }
}
```

`src/com/example/impl/ImplPlugin.java` implements `StoreService`:

```java
package com.example.impl;

import com.example.api.StoreService;
import org.bukkit.plugin.java.JavaPlugin;

import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

public class ImplPlugin extends JavaPlugin implements StoreService {
    private final Map<UUID, Integer> balances = new HashMap<>();

    @Override public void onEnable() {
        getServer().getServicesManager().register(StoreService.class, this, this, org.bukkit.plugin.ServicePriority.Normal);
    }

    @Override public int getBalance(UUID id) { return balances.getOrDefault(id, 0); }
    @Override public void setBalance(UUID id, int value) { balances.put(id, value); }
}
```

## The `addons/shop` workspace

Consumes `api` but not `impl`. It looks the `StoreService` up through Bukkit's `ServicesManager` at runtime.

```json
{
  "name": "shop",
  "version": "1.0.0",
  "main": "com.example.shop.ShopAddon",
  "dependencies": {
    "api": {
      "source": "workspace:api",
      "version": "*"
    }
  }
}
```

No shading. `impl` provides the `api` classes at runtime. `shop` is a compile-only consumer.

## Install

```bash
pluggy install
```

At the root, without flags, pluggy enumerates every workspace, collects their declared deps, and writes `pluggy.lock` at the repo root. For this layout the lockfile has one entry, `api`, with `integrity: sha256-pending-build` (the placeholder used for workspace deps; the real integrity isn't known until `api` is built).

## Build from the root

```bash
pluggy build
```

Output:

```text
build api
✓ api: /repo/api/bin/api-1.0.0.jar (6.1 KB, 1712ms)
build impl
✓ impl: /repo/impl/bin/impl-1.0.0.jar (8.4 KB, 1802ms)
build shop
✓ shop: /repo/addons/shop/bin/shop-1.0.0.jar (5.2 KB, 1630ms)

summary
  api: /repo/api/bin/api-1.0.0.jar (6.1 KB, 1712ms)
  impl: /repo/impl/bin/impl-1.0.0.jar (8.4 KB, 1802ms)
  shop: /repo/addons/shop/bin/shop-1.0.0.jar (5.2 KB, 1630ms)
```

Topological order: `api` first, then `impl` (shades `api`), then `shop`
(depends on `api` but doesn't shade).

## Develop against one workspace

```bash
cd impl
pluggy dev
```

`pluggy dev` is always one-at-a-time. It builds `impl` (which triggers `api` through the classpath resolution), boots a Paper server, and drops `impl`'s jar into `dev/plugins/`. It does **not** drop `api` into `dev/plugins/`. `api` isn't a runtime plugin in this layout, since it has no descriptor file in its jar.

To dev `shop` instead:

```bash
cd addons/shop
pluggy dev
```

`shop`'s `dev/` is its own staging dir; the two dev servers don't share
state.

## Build just one workspace from the root

```bash
pluggy build --workspace impl
```

pluggy refuses to run from inside `impl/` with `--workspace shop`:

```text
error: --workspace "shop" does not match the current workspace "impl". Run from the root to build a different workspace.
```

## Adding a new workspace

Scaffold the directory by hand (no `pluggy init` in a monorepo):

```bash
mkdir -p addons/auction/src/com/example/auction
```

Write `addons/auction/project.json`:

```json
{
  "name": "auction",
  "version": "1.0.0",
  "main": "com.example.auction.AuctionAddon",
  "dependencies": {
    "api": { "source": "workspace:api", "version": "*" }
  }
}
```

Add it to the root's `workspaces` array:

```json
"workspaces": ["api", "impl", "addons/shop", "addons/auction"]
```

Run `pluggy install` at the root to refresh the lockfile.

## Watch out for

- **Same-name deps with different versions.** If `impl` pins `adventure-api@4.17.0` and `shop` pins `adventure-api@4.18.0`, bulk install refuses to pick a winner: `install: conflicting declarations of "adventure-api" across workspaces...`. Align the versions in each `project.json`.
- **Circular workspace dependencies.** `api` -> `impl` -> `api`. `doctor` flags these: `Workspace graph: workspace dependency cycle detected: api -> impl -> api`. Extract the shared bits into a third workspace.
- **Running `dev` at the root.** `pluggy dev` requires `--workspace <name>` at a multi-workspace root.

## See also

- [Workspaces](../workspaces.md): the full reference.
- [`pluggy build`](../commands/build.md): topological ordering.
- [Dependencies](../dependencies.md): the `workspace:` source kind.
