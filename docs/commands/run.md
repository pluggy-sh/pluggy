# `pluggy run`

Invoke a named script across the selected workspaces. Scripts are declared under `project.scripts`; they cascade additively from the root the same way `dependencies` do.

`run` exists so projects can encode their lint, format, and CI tasks alongside their build commands without users needing to remember the underlying tool. The mental model matches `npm run` and `cargo run`.

## Defining scripts

```jsonc
// project.json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "scripts": {
    "lint": "vp check",
    "fmt": "vp fmt",
    "release-notes": "./scripts/release-notes.sh ${project.version}",
  },
}
```

Each value is a single command string. `${project.x}` and `${workspace.x}` substitution runs before tokenization, so the version above expands at run time.

`run` never spawns a shell. Pipes, redirects, and `&&` chains don't work. For anything multi-step, put it in a script file (`./scripts/release-notes.sh`) and reference the file from `scripts`.

## Listing scripts

Without a script name, `run` enumerates every script defined in the project, grouped by which workspaces declare it:

```text
$ pluggy run

Available scripts
  › fmt (in: api, core, plugin)
  › lint (in: api, core, plugin)
  › release-notes (in: plugin)
```

## Running a script

```text
$ pluggy run lint
[api] lint: vp check
[api] ✓ All 247 files are correctly formatted
[core] lint: vp check
[core] ✓ All 247 files are correctly formatted
[plugin] lint: vp check
[plugin] ✓ All 247 files are correctly formatted

summary
  api: ok (412ms)
  core: ok (398ms)
  plugin: ok (455ms)
```

Each workspace's stdout and stderr are prefixed with `[<workspace>]`. Under `--concurrency > 1` (the default), output is buffered per workspace and flushed as a block when the workspace finishes, so blocks stay readable instead of interleaving.

If a workspace doesn't declare the script (and didn't inherit one from the root), `run` skips it silently. If no workspace in the selection declares it, `run` exits with a clear error.

## Inheritance and opt-out

Root-declared scripts are visible in every workspace by default. A workspace overrides a single script by declaring it locally; the local value wins. Setting the value to `null` opts the workspace out of the inherited script entirely:

```jsonc
// api/project.json
{
  "name": "api",
  "scripts": {
    "lint": null, // skip lint here
  },
}
```

After inheritance, `api` has no `lint` script. `pluggy run lint` at the root sweeps the other workspaces.

## Passing arguments through

Anything after `--` flows through to the spawned command:

```text
$ pluggy run lint -- --quiet
[api] lint: vp check + --quiet
[api] ...
```

Args attach to every workspace's invocation. To pass workspace-specific args, define separate scripts.

## Flags

| Flag                  | Effect                                                               |
| --------------------- | -------------------------------------------------------------------- |
| `--workspace <names>` | Run in one or more workspaces. Repeatable; comma-separated.          |
| `--exclude <names>`   | Subtract from the default sweep.                                     |
| `--workspaces`        | Explicit "every workspace" at the root.                              |
| `--concurrency <n>`   | Cap on workspaces running simultaneously. `1` matches serial output. |

See [Workspaces: selection flags](../workspaces.md#selection-flags) for the shared syntax.

## Substitution

These names resolve inside script values:

| Placeholder            | Value                                              |
| ---------------------- | -------------------------------------------------- |
| `${project.name}`      | The workspace's `name`.                            |
| `${project.version}`   | The workspace's `version`.                         |
| `${project.x.y}`       | Any other dotted-path key from the merged project. |
| `${workspace.name}`    | Same as `${project.name}`; kept for clarity.       |
| `${workspace.rootDir}` | Absolute path to the workspace's directory.        |

Unknown placeholders pass through unchanged. Prefix with a backslash (`\${...}`) to keep one literal.

## JSON envelope

```json
{
  "status": "success",
  "results": [
    {
      "workspace": "api",
      "script": "lint",
      "expanded": ["vp", "check"],
      "ok": true,
      "exitCode": 0,
      "durationMs": 412
    }
  ]
}
```

When run with no script name, the envelope's `status` is `"list"` and the body carries a `scripts` array instead of `results`.

## See also

- [Workspaces: scripts inheritance](../workspaces.md#inheritance).
- [`pluggy build`](./build.md): for the canonical build action; you don't need a `scripts.build` entry.
