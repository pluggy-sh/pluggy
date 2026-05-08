# `pluggy init`

Scaffold a new plugin project. Writes `project.json`, a starter [main class](../glossary.md#main-class) matching your chosen platform family (Bukkit `JavaPlugin`, Velocity `@Plugin`, BungeeCord `Plugin`, or Sponge), and a template `config.yml`. Pass `--template <id>` to scaffold from a richer starter (MockBukkit harness, Adventure components, Folia region scheduler, and so on). See [Templates](#templates) for the full list.

## Usage

```text
pluggy init [options] [path]
```

`path` defaults to `.` (the current directory). Any other value is resolved
against `process.cwd()`.

## Flags

| Flag                    | Default                           | Notes                                                                                                                                                                           |
| ----------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--name <name>`         | basename of target dir            | Must match `^[a-zA-Z0-9_-]+$`.                                                                                                                                                  |
| `--version <semver>`    | `1.0.0`                           | Validated as `\d+\.\d+\.\d+(-[a-zA-Z0-9]+)?`.                                                                                                                                   |
| `--description <text>`  | `"A simple Minecraft plugin"`     | Free-form.                                                                                                                                                                      |
| `--main <fqcn>`         | `com.example.Main`                | Must be a Java classpath — at least `package.Class`.                                                                                                                            |
| `--platform <id>`       | `paper`                           | Any registered platform: `paper`, `folia`, `spigot`, `bukkit`, `velocity`, `waterfall`, `travertine`, `sponge`. Repeatable, but must stay within one descriptor family (see error cases). |
| `--mc-version <semver>` | highest compatible across targets | Minecraft version written to `compatibility.versions[0]`. Accepts both the legacy `1.21.8` shape and Mojang's new calendar scheme (`26.1.2`). See below.                        |
| `--template <id>`       | embedded family stub              | Scaffold from a richer template — see [Templates](#templates). Without this flag init uses the embedded family stub and never touches the network.                              |
| `-y, --yes`             | off                               | Skip confirmations. Always on under `--json`.                                                                                                                                   |

The `--version` here refers to the plugin's own `project.version`. The
Minecraft version lives at `compatibility.versions[0]` and is set by
`--mc-version`.

When `--mc-version` is omitted, pluggy calls `getVersions()` on every selected platform in parallel, intersects the results, and picks the highest version every target publishes. That way a multi-platform init (for example `paper + spigot`) can't pick a Paper-only release.

When `spigot` or `bukkit` is in the target set, init also skips any candidate whose declared `javaVersions` range excludes the JDK on `PATH`. Otherwise BuildTools would pick up a Minecraft release it can't actually decompile (`26.1.2` requires Java 25+). The newest version your Java can compile wins.

All platforms, including `velocity` and `sponge`, surface Minecraft versions here. The `velocity-api` and `spongeapi` Maven coordinates are resolved internally to their latest stable releases, so `compatibility.versions` stays a single Minecraft-version vocabulary across the whole project.

If the intersection is empty, init errors with "No compatible Minecraft version found across platforms: …" and suggests either dropping platforms or passing `--mc-version` explicitly. Expect a short network wait on first run.

## Files produced

```text
<target>/
├── project.json
├── src/
│   ├── config.yml
│   └── com/example/Main.java    (or whatever --main resolves to)
```

The `.java` and `.yml` stubs are rendered through the `${project.x}`
templater before being written, so they reference the real project name /
version / class name / package name.

The exact `.java` stub depends on the platform family of the project's
primary platform:

- `paper`, `folia`, `spigot`, `bukkit`: `extends JavaPlugin`.
- `velocity`: `@Plugin` annotated, `@Inject`-ed `ProxyServer` and `Logger`.
- `waterfall`, `travertine`: `extends net.md_5.bungee.api.plugin.Plugin`.
- `sponge`: `@Plugin` annotated with `@Inject`-ed `Logger`.

So `pluggy init --yes --platform velocity` produces a Velocity-correct stub that compiles immediately, with no manual fix-up needed.

## Templates

`--template <id>` scaffolds from a starter project hosted in this repo under `templates/<id>/`. Each template ships a tested layout (listener and command, MockBukkit harness, Adventure components, Folia region scheduler, proxy plugin shapes) so you start from working code rather than a bare `onEnable`.

The current lineup:

| ID                 | Family   | Notes                                                                                    |
| ------------------ | -------- | ---------------------------------------------------------------------------------------- |
| `paper-basic`      | bukkit   | Paper + a sample `JoinListener`. Smallest non-empty scaffold.                            |
| `paper-mockbukkit` | bukkit   | Paper + listener + a JUnit/MockBukkit lifecycle harness driven by `pluggy test`.         |
| `paper-adventure`  | bukkit   | Paper using Adventure `Component`s + a MockBukkit test for the listener.                 |
| `folia-regions`    | bukkit   | Folia plugin showing `getAsyncScheduler()` / `getRegionScheduler()` patterns.            |
| `velocity-proxy`   | velocity | Velocity with `@Inject` lifecycle, `ServerPostConnectEvent` listener, Brigadier command. |
| `bungee-proxy`     | bungee   | BungeeCord with a `PostLoginEvent` listener and a registered `Command`.                  |

Picking interactively without `--template` shows the same list filtered to
your platform's family. Selecting "Default" falls through to the embedded
stub (no network).

Templates are fetched from this repo's `main` branch by default. Override with:

- `PLUGGY_TEMPLATE_REPO=<owner>/<repo>[#<ref>]`: fetch from a fork or pin to a specific ref.
- `PLUGGY_TEMPLATE_DIR=<path>`: read templates straight off disk (used by pluggy's own tests and by anyone iterating on a template locally).

A template's `template.json` may declare `projectJsonExtras`, which pluggy deep-merges into the generated `project.json`. That's how `paper-mockbukkit` injects `testDependencies.mockbukkit` for you.

## Prompts

Without `-y`, pluggy walks through an interactive session:

- **Non-empty target confirm**: scaffolding into a directory that already has files, or nesting a new project inside an existing pluggy project. Defaults to "no".
- **Project name**: pre-filled with the target basename. Skipped when `--name` is passed or a positional `path` is given.
- **Target platforms**: checkbox list of every registered platform, with `paper` pre-selected. Skipped when `--platform` is passed. Requires at least one selection.
- **Main class**: pre-filled with `com.example.<DerivedClassName>`, where the class name is derived from the project name by splitting on `-` and `_` and PascalCasing. Skipped when `--main` is passed.
- **IDE integration**: checkbox list of VS Code, IntelliJ IDEA, and Eclipse. Selections are written to `project.ide`, which makes `pluggy build` emit project files for those editors. Leave the selection empty to skip IDE scaffolding.

Under `--json` or `-y`, the non-empty-dir situation throws instead of prompting (an interactive prompt in a non-interactive session would hang forever) and every other prompt falls back to its default: `paper` for platforms, no IDE integration, derived name and main class.

## Human output

```text
$ pluggy init --yes --name example --main com.example.Main --platform paper
Project "example" initialized successfully at /tmp/example
```

## JSON output

```json
{
  "status": "success",
  "project": {
    "name": "example",
    "version": "1.0.0",
    "description": "A simple Minecraft plugin",
    "main": "com.example.Main",
    "compatibility": {
      "versions": ["1.21.8"],
      "platforms": ["paper"]
    }
  },
  "dir": "/tmp/example"
}
```

## Error cases

| Trigger                           | Message                                                                                                                                                                                                                          |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Invalid `--name`                  | `Invalid project name: "<name>". Only alphanumeric characters, underscores, and hyphens are allowed.`                                                                                                                            |
| Invalid `--main`                  | `Invalid main class: "<main>". It must be a valid Java classpath (e.g., com.example.Main).`                                                                                                                                      |
| Unknown `--platform`              | `Invalid platform: "<p>". Available platforms: paper, folia, spigot, bukkit, velocity, waterfall, travertine, sponge`                                                                                                                    |
| Cross-family platforms            | `Platform "<b>" cannot be combined with "<a>" because they target different plugin families ("<a>" writes "<path-a>", "<b>" writes "<path-b>"). Proxy platforms like velocity, waterfall, and travertine each need their own project.` |
| No MC version common to platforms | `No compatible Minecraft version found across platforms: <list>. Try selecting fewer platforms or specifying a version manually with --mc-version.`                                                                              |
| Non-empty target dir (no `-y`)    | Interactive confirm. "no" aborts with `Aborted.`.                                                                                                                                                                                |
| Existing project dir (no `-y`)    | As above.                                                                                                                                                                                                                        |

Network failures during `getVersions()` propagate from the platform
provider — see [Troubleshooting](../troubleshooting.md#network-errors-during-init-or-dev).

## See also

- [`project.json` reference](../project-json.md): what the output config means and how to extend it.
- [Getting started](../getting-started.md): the full from-zero walkthrough.
