# Templates

Starter projects that `pluggy init --template <id>` scaffolds. Each template
is a self-contained example of a plugin shape — bare scaffolds, MockBukkit
test harnesses, Adventure component usage, Folia region schedulers, and
proxy-plugin layouts for Velocity / BungeeCord.

## Layout

```
templates/
  index.json            # registry: { id, name, description, family }
  <id>/
    template.json       # per-template metadata + projectJsonExtras
    files/              # source tree copied into the user's project
      src/__packagePath__/__className__.java
      src/config.yml
      test/__packagePath__/__className__Test.java
```

`__packagePath__` and `__className__` are substituted in **filenames** with
the user's choices (`com/example/MyPlugin` and `MyPlugin`). File **contents**
go through `${project.x}` substitution — same engine the rest of pluggy uses
for `plugin.yml` etc. Notable extras exposed to templates:

| placeholder                           | meaning                             |
| ------------------------------------- | ----------------------------------- |
| `${project.name}`                     | Project name (sanitised)            |
| `${project.version}`                  | Project version                     |
| `${project.description}`              | Project description                 |
| `${project.main}`                     | Fully-qualified main class          |
| `${project.className}`                | Last segment of `main`              |
| `${project.packageName}`              | `main` minus the class              |
| `${project.velocityId}`               | Velocity-style id derived from name |
| `${project.compatibility.versions.0}` | First MC version                    |

## How `--template` works

1. The CLI fetches `index.json` from the active template source (default:
   this repo's `main` branch).
2. The user picks a template (interactive list filtered to the project's
   platform family, or `--template <id>`).
3. The CLI downloads the repo zip from `codeload.github.com`, extracts only
   `templates/<id>/`, applies path + content substitution, and merges
   `template.json#projectJsonExtras` into the generated `project.json`.

When `--template` isn't supplied (e.g. `pluggy init --yes`), pluggy uses the
embedded family stub (`src/defaults/<family>-package.java`) — that path
needs no network and is what backs `pluggy init` offline.

## Adding a template

1. Create `templates/<id>/template.json` and `templates/<id>/files/...`.
2. Add an entry to `templates/index.json`. `family` must be one of
   `bukkit`, `velocity`, `bungee` — the CLI filters by family.
3. Use `__packagePath__` / `__className__` in filenames; `${project.x}` in
   contents.
4. If your template needs extra deps, declare them under
   `template.json#projectJsonExtras.dependencies` (or `.testDependencies`).
   They go through the same `${...}` substitution pass as files do.
