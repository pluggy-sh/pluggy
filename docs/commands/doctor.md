# `pluggy doctor`

Print an environment summary plus a fixed set of project and toolchain checks. Designed for two roles at once: a quick "is everything OK?" before a build, and a paste-friendly status report for filing issues.

Exits `0` when no check failed, `1` otherwise. Warnings are informational and do not affect the exit code.

## Usage

```text
pluggy doctor [options]
```

## Flags

| Flag       | Default | Notes                                                                          |
| ---------- | ------- | ------------------------------------------------------------------------------ |
| `--report` | off     | Print a paste-friendly markdown block wrapped in `<details>` for issue filing. |
| `--fix`    | off     | Apply safe, non-destructive remediations after the checks run. See below.      |

`--json` works as a global flag.

## What gets printed

Doctor groups its output into four blocks. Run with `--report` to get the same data formatted as markdown for pasting into an issue.

### Environment

Always shown. Lists pluggy version, OS plus release plus arch, runtime (`bun` or `node`), terminal info (TTY, columns, locale), the names (not values) of pluggy-relevant env vars that are set, the cache and state directory paths, and the install method (`Homebrew`, `Scoop`, `install script`, or `unknown`) plus the resolved binary path. When PATH contains additional pluggy binaries that shadow each other, doctor warns and lists them.

### Project

Shown when run inside a project. Lists the workspace name, version, primary platform, primary Minecraft version, workspace count, and declared dependency count.

### Lockfile

Shown when `pluggy.lock` exists. Lists schema version, total entry count, top-level vs transitive split, orphan count, and the file's last-modified timestamp.

### Checks

Every check returns one of `pass`, `warn`, `fail`. Only `fail` affects the exit code.

| id                      | label                    | fail trigger                                                                                      |
| ----------------------- | ------------------------ | ------------------------------------------------------------------------------------------------- |
| `project-found`         | Project location         | No `project.json` found anywhere up to the filesystem root.                                       |
| `java`                  | Java toolchain           | `java -version` fails (not on PATH, or non-zero exit).                                            |
| `sdk`                   | Project JDK              | Required JDK isn't cached and `PLUGGY_NO_AUTO_INSTALL=1` is set.                                  |
| `cache`                 | Cache reachability       | Path exists but isn't a directory, or the probe write fails.                                      |
| `hotswap`               | HotswapAgent + JBR       | The pinned agent or JBR slot fails to provision.                                                  |
| `registry <url>`        | Registry                 | (Warning only.) `HEAD` returns a 5xx or the request errors. 2xx, 3xx, and 4xx count as reachable. |
| `project (<name>)`      | Validate `project.json`  | `name`, `version`, or `compatibility` is malformed, or the platform is unknown.                   |
| `version-compat (<ws>)` | Version compatibility    | The Minecraft version isn't supported by the primary platform.                                    |
| `workspace`             | Workspace graph          | Cycle detected in `workspace:` deps.                                                              |
| `descriptor (<name>)`   | Descriptor family        | `pickDescriptor` throws (unknown platform, mixed families).                                       |
| `outdated`              | Outdated dependencies    | (Warning only.) Any Modrinth or Maven dep has a newer stable version.                             |
| `dependency-compat`     | Dependency compatibility | A locked jar's class-file version is newer than the project's JDK can read.                       |
| `pluggy-version`        | Pluggy version           | (Warning only.) A newer release is available on GitHub.                                           |
| `lockfile`              | Lockfile health          | (Warning only.) Orphan transitive entries (no top-level pulls them in any more).                  |

When run outside a project, doctor still emits the Environment block and a single failed `project-found` check. This makes it useful for "does my install look right?" debugging before scaffolding a project.

## Human output

```text
$ pluggy doctor
pluggy doctor

Environment
  › pluggy 0.1.0
  › os: darwin 25.3.0 (arm64)
  › runtime: bun 1.3.13
  › terminal: TTY=yes columns=120
  › locale: en_US.UTF-8
  › env vars set: JAVA_HOME
  › cache: /Users/you/Library/Caches/pluggy
  › state: /Users/you/Library/Application Support/pluggy
  › install: install script (/Users/you/.pluggy/bin/pluggy)

Project
  › name: my_plugin@1.0.0
  › primary: paper 1.21.8
  › workspaces: 0
  › declared dependencies: 2

Lockfile
  › version: 2
  › entries: 6 (2 top-level, 4 transitive)
  › orphans: 0
  › last modified: 2026-05-10T09:38:41.818Z

Checks
  ✓ Java toolchain: Java 21
  ✓ Project JDK: temurin 21 cached (/Users/you/Library/Caches/pluggy/jdk/temurin-21-...)
  ✓ Cache reachability: /Users/you/Library/Caches/pluggy (2.70 GB)
  ✓ HotswapAgent + JBR: agent 2.0.3, JBR 21.0.5 cached
  ✓ Registries: no extra registries declared
  ✓ project.json (my_plugin): name=my_plugin, version=1.0.0
  ✓ Version compatibility (paper): 1.21.8
  ✓ Workspace graph: standalone project
  ✓ Descriptor family (my_plugin): paper → plugin.yml
  ✓ Outdated dependencies: 2 deps up to date
  ✓ Dependency compatibility: 6 jars compatible with Java 21
  ✓ Pluggy version: 0.1.0
  ✓ Lockfile: 6 entries, no orphans

✓ 13 passed, 0 warned, 0 failed
```

The summary line is always `<n> passed, <n> warned, <n> failed`. The exit code reflects only the failed count.

## `--fix` output

`--fix` applies the safe remediations the checks would otherwise just report. It never deletes source code, downloads anything new, or touches the user cache. Today's set:

| Fix id            | What it does                                                                            |
| ----------------- | --------------------------------------------------------------------------------------- |
| `lockfile-prune`  | Removes orphan transitive entries from `pluggy.lock`.                                   |
| `workspace-prune` | Drops `workspaces[]` entries in the root `project.json` that point at a missing folder. |

`workspace-prune` runs before any other check so an unloadable workspace context (caused by a deleted folder) doesn't block the rest of doctor. The applied fixes are reported in a `Fixes applied` block at the bottom of the output.

```text
$ pluggy doctor --fix
... checks ...

Fixes applied
  › ✓ removed 1 missing workspace from root project.json (./old-module)
  › ✓ pruned 3 orphan entries from pluggy.lock

✓ 14 passed, 0 warned, 0 failed
```

## `--report` output

`--report` produces a markdown block wrapped in `<details><summary>`. Paste it directly into a GitHub issue:

```text
$ pluggy doctor --report
<details><summary>pluggy doctor report</summary>

### Environment

- pluggy: 0.1.0
- os: darwin 25.3.0 (arm64)
- runtime: bun 1.3.13
- terminal: TTY=yes columns=120
- locale: en_US.UTF-8
- env vars set: JAVA_HOME
- cache: /Users/you/Library/Caches/pluggy
- state: /Users/you/Library/Application Support/pluggy
- install: install script (/Users/you/.pluggy/bin/pluggy)

### Project

- name: my_plugin
- version: 1.0.0
- primary platform: paper
- primary version: 1.21.8
- workspaces: 0
- dependencies: 2

### Lockfile

- version: 2
- entries: 6
- top-level: 2
- transitive: 4
- orphans: 0
- last modified: 2026-05-10T09:38:41.818Z

### Checks

| Status | Check | Detail |
| --- | --- | --- |
| [ok] | Java toolchain | Java 21 |
| [ok] | Project JDK | temurin 21 cached (...) |
| ...  |               |        |

Summary: 13 passed, 0 warned, 0 failed

</details>
```

Env vars are listed by **name only**, never by value. Cache and state paths are absolute. The report never includes registry credentials, lockfile hashes, or workspace contents.

## JSON output

```json
{
  "status": "success",
  "ok": true,
  "environment": {
    "pluggy": { "version": "0.1.0" },
    "os": { "platform": "darwin", "release": "25.3.0", "arch": "arm64" },
    "runtime": { "name": "bun", "version": "1.3.13" },
    "terminal": { "isTTY": true, "columns": 120 },
    "envVarsSet": ["JAVA_HOME"],
    "paths": {
      "cache": "/Users/you/Library/Caches/pluggy",
      "state": "/Users/you/Library/Application Support/pluggy"
    },
    "locale": "en_US.UTF-8",
    "project": {
      "name": "my_plugin",
      "version": "1.0.0",
      "primaryPlatform": "paper",
      "primaryVersion": "1.21.8",
      "workspaces": 0,
      "dependencies": 2
    },
    "lockfile": {
      "version": 2,
      "entries": 6,
      "topLevel": 2,
      "transitive": 4,
      "orphans": 0,
      "lastModifiedAt": "2026-05-10T09:38:41.818Z"
    }
  },
  "checks": [{ "id": "java", "label": "Java toolchain", "status": "pass", "detail": "Java 21" }],
  "failures": []
}
```

`environment.project` and `environment.lockfile` are omitted when no project or lockfile is found. With at least one `fail`, the envelope goes to stderr, `ok` is `false`, and the exit code is `1`.

## Failure examples

```text
✗ Java toolchain: java not found or failed to run: spawn java ENOENT
✗ Cache reachability: cache is not writable: /cache/pluggy (EACCES: permission denied)
✗ project.json (my_plugin): invalid or missing "version": 1.0
✗ Workspace graph: workspace dependency cycle detected: a -> b -> a
✗ Descriptor family (mixed): build: project "mixed" declares platforms from different descriptor families ("paper" uses "plugin.yml", "velocity" uses "velocity-plugin.json"). Split them into separate workspaces, one per family.
```

## See also

- [Troubleshooting](../troubleshooting.md): the same failures with remediation.
- [`pluggy build`](./build.md): descriptor and workspace checks are a subset of what runs during a build.
- [`pluggy audit`](./audit.md): verify cached jar bytes against the lockfile.
- [`pluggy outdated`](./outdated.md): the `Outdated dependencies` check uses the same machinery.
