# `pluggy init`

Scaffold a new plugin project. Writes `project.json`, a Bukkit `JavaPlugin`
stub, and a template `config.yml`.

## Usage

```text
pluggy init [options] [path]
```

`path` defaults to `.` (the current directory). Any other value is resolved
against `process.cwd()`.

## Flags

| Flag                    | Default                       | Notes                                                                                                             |
| ----------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `--name <name>`         | basename of target dir        | Must match `^[a-zA-Z0-9_-]+$`.                                                                                    |
| `--version <semver>`    | `1.0.0`                       | Validated as `\d+\.\d+\.\d+(-[a-zA-Z0-9]+)?`.                                                                     |
| `--description <text>`  | `"A simple Minecraft plugin"` | Free-form.                                                                                                        |
| `--main <fqcn>`         | `com.example.Main`            | Must be a Java classpath — at least `package.Class`.                                                              |
| `--platform <id>`       | `paper`                       | Any registered platform: `paper`, `folia`, `spigot`, `bukkit`, `velocity`, `waterfall`, `travertine`. Repeatable. |
| `--mc-version <semver>` | highest common across targets | Minecraft version written to `compatibility.versions[0]`. See below.                                              |
| `-y, --yes`             | off                           | Skip confirmations. Always on under `--json`.                                                                     |

The `--version` here refers to the plugin's own `project.version`. The
Minecraft version lives at `compatibility.versions[0]` and is set by
`--mc-version`.

When `--mc-version` is omitted, pluggy calls `getVersions()` on every
selected platform in parallel, intersects the results, and picks the
highest version that every target publishes. That way a multi-platform
init (e.g. `paper + spigot`) can never pick a Paper-only release. If the
intersection is empty, init errors with "No compatible Minecraft version
found across platforms: …" and suggests either dropping platforms or
passing `--mc-version` explicitly. Expect a short network wait on first
run.

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

## Prompts

Without `-y`, pluggy walks through an interactive session:

- **Non-empty target confirm** — scaffolding into a directory that already
  has files, or nesting a new project inside an existing pluggy project.
  Defaults to "no".
- **Project name** — pre-filled with the target basename. Skipped when
  `--name` is passed or a positional `path` is given.
- **Target platforms** — checkbox list of every registered platform, with
  `paper` pre-selected. Skipped when `--platform` is passed. Requires at
  least one selection.
- **Main class** — pre-filled with `com.example.<DerivedClassName>`,
  where the class name is derived from the project name by splitting on
  `-`/`_` and PascalCasing. Skipped when `--main` is passed.
- **IDE integration** — checkbox list of `VS Code`, `IntelliJ IDEA`, and
  `Eclipse`. Selections are written to `project.ide`, which makes
  `pluggy build` emit project files for those editors. The prompt always
  runs in interactive mode; leave it empty to skip IDE scaffolding.

Under `--json` or `-y`, the non-empty-dir situation throws instead of
prompting — an interactive prompt in a non-interactive session would
hang forever — and every other prompt falls back to its default
(`paper` for platforms, no IDE integration, derived name/main).

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

| Trigger                           | Message                                                                                                                                             |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Invalid `--name`                  | `Invalid project name: "<name>". Only alphanumeric characters, underscores, and hyphens are allowed.`                                               |
| Invalid `--main`                  | `Invalid main class: "<main>". It must be a valid Java classpath (e.g., com.example.Main).`                                                         |
| Unknown `--platform`              | `Invalid platform: "<p>". Available platforms: paper, folia, spigot, bukkit, velocity, waterfall, travertine`                                       |
| No MC version common to platforms | `No compatible Minecraft version found across platforms: <list>. Try selecting fewer platforms or specifying a version manually with --mc-version.` |
| Non-empty target dir (no `-y`)    | Interactive confirm; "no" aborts with `Aborted.`                                                                                                    |
| Existing project dir (no `-y`)    | As above.                                                                                                                                           |

Network failures during `getVersions()` propagate from the platform
provider — see [Troubleshooting](../troubleshooting.md#network-errors-during-init-or-dev).

## See also

- [`project.json` reference](../project-json.md) — what the output config
  means and how to extend it.
- [Getting started](../getting-started.md) — the full from-zero walkthrough.
