# Workspaces

A monorepo with multiple plugin projects in one repo. Each [workspace](./glossary.md#workspace) has its own `project.json`, its own jar, and can depend on sibling workspaces through the `workspace:` source kind.

## When to use workspaces

The simplest plugin is a single `project.json` at the repo root. You don't need workspaces unless you have:

- A shared API module that multiple implementations depend on.
- Separate plugins for Paper and Velocity in one repo. Different [descriptor families](./glossary.md#descriptor-family) can't live in one workspace.
- A larger family of add-ons with their own versions and release cadences.

Anything else is probably one workspace.

## Layout

```text
my-repo/
├── project.json            (root)
├── pluggy.lock             (shared across every workspace)
├── api/
│   ├── project.json
│   └── src/
├── impl/
│   ├── project.json
│   └── src/
└── addons/
    └── store/
        ├── project.json
        └── src/
```

The root `project.json` declares its children via the `workspaces` field:

```json
{
  "name": "my_repo",
  "version": "0.0.0",
  "compatibility": {
    "versions": ["1.21.8"],
    "platforms": ["paper"]
  },
  "authors": ["Shared Author"],
  "workspaces": ["api", "impl", "addons/store"]
}
```

Workspace paths are forward-slashed and resolved against the root directory. Absolute paths work but are rare. Each referenced directory must contain its own `project.json`.

A root that declares `workspaces` doesn't have to declare `main`. It's not buildable in its own right. When you run `pluggy build` at the root, it builds every workspace in [topological order](./glossary.md#topological-order).

## How pluggy classifies your location

When you run any command, pluggy walks up from `cwd` until it finds a `project.json`. From that file it decides:

| Condition                                                   | `atRoot` | `current`      |
| ----------------------------------------------------------- | -------- | -------------- |
| Found `project.json` declares `workspaces`                  | `true`   | none           |
| Found `project.json` is inside a parent's `workspaces` list | `false`  | that workspace |
| Found `project.json` is standalone                          | `true`   | none           |

Scope-aware commands (`install`, `remove`, `build`, `list`) use this classification to decide what to act on. See each command's docs for its specific scope rules.

## Inheritance

Workspaces inherit the following fields from the root when unset:

- `compatibility`
- `authors`
- `description`

`registries` are **unioned** across the root and every workspace. Duplicates drop by URL. This is so a workspace can declare its own registry without re-declaring the root's.

Everything else (`name`, `version`, `main`, `dependencies`, `shading`, `resources`, `dev`) is workspace-local. A workspace's own `compatibility` wins over the root's when both declare it.

### What "inherited" looks like

Root:

```json
{
  "name": "my_repo",
  "version": "0.0.0",
  "compatibility": {
    "versions": ["1.21.8"],
    "platforms": ["paper"]
  },
  "authors": ["Alice"],
  "registries": ["https://repo.papermc.io/repository/maven-public/"],
  "workspaces": ["api", "impl"]
}
```

`api/project.json`:

```json
{
  "name": "api",
  "version": "1.0.0",
  "main": "com.example.api.Api"
}
```

After inheritance, `api`'s effective project sees:

```json
{
  "name": "api",
  "version": "1.0.0",
  "main": "com.example.api.Api",
  "compatibility": {
    "versions": ["1.21.8"],
    "platforms": ["paper"]
  },
  "authors": ["Alice"],
  "registries": ["https://repo.papermc.io/repository/maven-public/"]
}
```

`list`, `build`, and `dev` all read this merged view.

## `workspace:` dependencies

One workspace depends on another by slug:

```json
// impl/project.json
{
  "name": "impl",
  "version": "1.0.0",
  "main": "com.example.impl.Impl",
  "dependencies": {
    "api": { "source": "workspace:api", "version": "*" }
  }
}
```

At resolve time, `workspace:api` points at `<api.rootDir>/bin/api-<api.version>.jar`. The build pipeline expects this jar to already exist. If it doesn't:

```text
shade: workspace dependency "api" has not been built yet, expected jar at "/repo/api/bin/api-1.0.0.jar". Build the sibling workspace first (topological order is the caller's responsibility).
```

Running `pluggy build` at the repo root handles this. pluggy sorts workspaces topologically so `api` builds before `impl`.

The `version` field in the dep declaration is ignored. The sibling's own `project.json:version` is authoritative. Using `"version": "*"` is the idiomatic value.

## Topological order

```text
$ pluggy build
build api
✓ api: /repo/api/bin/api-1.0.0.jar (42.1 KB, 1802ms)
build impl
✓ impl: /repo/impl/bin/impl-1.0.0.jar (98.3 KB, 2103ms)
build addons-store
✓ addons-store: /repo/addons/store/bin/addons-store-1.0.0.jar (56.4 KB, 1902ms)
```

`pluggy doctor` verifies there are no cycles:

```text
✗ Workspace graph: workspace dependency cycle detected: api -> impl -> api
```

Cycles throw from `topologicalOrder`. Break them by extracting a third workspace that both sides depend on.

## Common commands in a monorepo

| You want to...              | Run                                                                   |
| --------------------------- | --------------------------------------------------------------------- |
| Build everything            | `pluggy build` at the root                                            |
| Build one workspace         | `pluggy build --workspace impl` at the root                           |
| Add a dep to one workspace  | `pluggy install --workspace impl worldedit`                           |
| Refresh the shared lockfile | `pluggy install` at the root (defaults to all workspaces)             |
| List aggregated deps        | `pluggy list --workspaces` at the root                                |
| Run the dev server          | `cd impl && pluggy dev`, or `pluggy dev --workspace impl` at the root |

`dev` is always one-at-a-time. There's no `--workspaces` equivalent for live servers. Pick the workspace you're iterating on.

## Shading across workspaces

A workspace can shade a sibling's classes:

```json
// impl/project.json
{
  "dependencies": {
    "api": { "source": "workspace:api", "version": "*" }
  },
  "shading": {
    "api": { "include": ["com/example/api/**"] }
  }
}
```

The resolver returns a placeholder `integrity: "sha256-pending-build"` for workspace deps until the sibling has been built. The shade step checks for the jar at build time and errors if it's missing. The topological order from the root build is what prevents that.

## Multi-family monorepos

A typical split:

```text
my-network/
├── project.json            (root: paper compat, no build)
├── backend/
│   └── project.json        (paper, plugin.yml)
└── proxy/
    └── project.json        (velocity, velocity-plugin.json)
```

Each workspace keeps its own descriptor family. The root's inherited `compatibility` is overridden by `proxy` with its own `{ "versions": ["1.21.11"], "platforms": ["velocity"] }`. `versions` is always a Minecraft version, even for proxy platforms. The `velocity-api` Maven coordinate is resolved internally. `pluggy build` produces one jar per workspace.

If you'd tried to put paper and velocity in a single workspace's `compatibility.platforms`, `build` would refuse:

```text
build: project "mixed" declares platforms from different descriptor families ("paper" uses "plugin.yml", "velocity" uses "velocity-plugin.json"). Split them into separate workspaces, one per family.
```

## See also

- [`pluggy build`](./commands/build.md): scope rules and topological ordering.
- [`pluggy install`](./commands/install.md): conflict detection when two workspaces declare the same dep with different versions.
- [Dependencies](./dependencies.md#source-kinds): the `workspace:` source in the full grammar.
