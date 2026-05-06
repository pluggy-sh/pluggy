# `pluggy doctor`

Validate the host environment and every workspace in the current project.
Runs a fixed set of checks; exits `0` when nothing has failed, `1`
otherwise. Warnings are informational.

## Usage

```text
pluggy doctor
```

No flags beyond the global `--json`.

## Checks

Every check returns one of `pass`, `warn`, `fail`. Only `fail` affects
the exit code.

| id                    | label                   | fail trigger                                                       | warn trigger                                                                                                                            |
| --------------------- | ----------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `java`                | Java toolchain          | `java -version` fails (not on PATH, or non-zero exit).             | Primary platform is `spigot` or `bukkit` **and** the detected JDK is older than the Java floor declared by the cached `BuildTools.jar`. |
| `cache`               | Cache reachability      | Path exists but isn't a directory; probe write fails.              | Directory doesn't exist yet (will be created on first use).                                                                             |
| `registry <url>`      | Registry                | —                                                                  | `HEAD` returns a 5xx or the request errors. 2xx / 3xx / 4xx count as reachable.                                                         |
| `project (<name>)`    | Validate `project.json` | `name`, `version`, or `compatibility` malformed; platform unknown. | —                                                                                                                                       |
| `workspace`           | Workspace graph         | Cycle detected in `workspace:` deps.                               | —                                                                                                                                       |
| `descriptor (<name>)` | Descriptor family       | `pickDescriptor` throws (unknown platform, mixed families).        | —                                                                                                                                       |
| `outdated`            | Outdated dependencies   | —                                                                  | Any Modrinth dep has a newer stable version, or any Modrinth query failed.                                                              |
| `pluggy-version`      | Pluggy version          | —                                                                  | A newer release is available on GitHub, or the latest release couldn't be reached.                                                      |

### Environment checks

- `java -version` is spawned without a shell. Output is parsed for the
  major version. pluggy accepts both the old `1.8.0_302` and modern
  `21.0.2` formats.
- For `spigot` / `bukkit` projects, pluggy reads the `Build-Jdk-Spec`
  manifest attribute from the cached `BuildTools.jar` to determine the
  minimum Java required. This keeps the check accurate as the SpigotMC
  team updates BuildTools' JDK floor. If `BuildTools.jar` isn't cached
  yet or the attribute is missing, the floor defaults to Java 8.
- The cache directory is stat-checked, then probed with a `writeFile` +
  `unlink` at `.pluggy-doctor-probe-<pid>`. Missing permissions fail the
  check.
- Every declared registry is hit with `HEAD` and a 5-second timeout. A
  non-existent registry warns rather than fails — some Maven repos reject
  HEAD on the index, which would surface as a false-positive fail.

### Project checks

- Workspace `name` / `version` / `compatibility` are re-validated with
  the same regex pluggy uses at `init` time.
- In a monorepo, every workspace is validated — one bad leaf surfaces
  even if the root is fine.
- `pickDescriptor` is run for every buildable workspace (the root in a
  multi-workspace repo has no descriptor and is skipped).

### Outdated check

Reads the lockfile and queries Modrinth for the latest stable version of
every Modrinth entry. Transient Modrinth failures degrade to `warn` with
"could not query N deps"; successful comparisons that find newer
versions emit `warn` with `name: current → latest` pairs.

## Human output

```text
pluggy doctor
  ✔ Java toolchain — Java 21
  ✔ Cache reachability — /Users/you/Library/Caches/pluggy (128.4 MB)
  ✔ Registries — no extra registries declared
  ✔ project.json (my_plugin) — name=my_plugin, version=1.0.0
  ✔ Workspace graph — standalone project
  ✔ Descriptor family (my_plugin) — paper → plugin.yml
  ! Outdated dependencies — worldedit: 7.3.15 → 7.4.0

✔ all required checks passed
```

The exit code is still `0` — warnings don't fail the command.

## JSON output

```json
{
  "status": "success",
  "ok": true,
  "checks": [
    { "id": "java", "label": "Java toolchain", "status": "pass", "detail": "Java 21" },
    {
      "id": "cache",
      "label": "Cache reachability",
      "status": "pass",
      "detail": "/Users/you/Library/Caches/pluggy (128.4 MB)"
    },
    {
      "id": "outdated",
      "label": "Outdated dependencies",
      "status": "warn",
      "detail": "worldedit: 7.3.15 → 7.4.0"
    }
  ],
  "failures": []
}
```

With at least one `fail`, the envelope goes to stderr, `ok` is `false`,
and the exit code is `1`.

## Failure examples

```text
✖ Java toolchain — java not found or failed to run: spawn java ENOENT
✖ Cache reachability — cache is not writable: /cache/pluggy (EACCES: permission denied)
✖ project.json (my_plugin) — invalid or missing "version": 1.0
✖ Workspace graph — workspace dependency cycle detected: a -> b -> a
✖ Descriptor family (mixed) — build: project "mixed" declares platforms from different descriptor families ("paper" uses "plugin.yml", "velocity" uses "velocity-plugin.json"). Split them into separate workspaces — one per family.
```

## See also

- [Troubleshooting](../troubleshooting.md) — the same failures with
  remediation.
- [`pluggy build`](./build.md) — descriptor and workspace checks are
  a subset of what runs during a build.
