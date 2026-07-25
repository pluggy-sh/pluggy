# Error codes

Every error pluggy raises deliberately carries a stable `code`. Scripts should branch on the code, not on the message: messages get reworded, codes do not.

```text
$ pluggy build
error [E_BUILD_NO_PROJECT]: No pluggy project found. Run this from inside a project directory.
  hint: Run `pluggy init` to create a new project, or cd into an existing one.
```

Under `--json` the same error is an envelope:

```json
{
  "status": "error",
  "exitCode": 2,
  "message": "No pluggy project found. Run this from inside a project directory.",
  "code": "E_BUILD_NO_PROJECT",
  "hint": "Run `pluggy init` to create a new project, or cd into an existing one."
}
```

Codes are named `E_<AREA>_<KIND>`. `src/program.test.ts` fails the build when a code exists in the source but not on this page, so this list cannot drift.

## Exit codes

The code tells you what went wrong; the exit status tells you whose fault it was.

| Exit | Meaning                                                                        |
| ---- | ------------------------------------------------------------------------------ |
| 0    | Success.                                                                       |
| 1    | A runtime or I/O failure: a download failed, a compile failed, a check failed. |
| 2    | The invocation was wrong: bad flag, bad argument, no project, ambiguous scope. |
| 130  | Interrupted with Ctrl+C.                                                       |

An error with no code is a bug in pluggy rather than a condition it anticipated. Please report those.

## No project found

Every workspace-aware command raises its own variant when it cannot find a `project.json`, so a script can tell which step failed. All exit 2, and all suggest `pluggy init`.

`E_AUDIT_NO_PROJECT`, `E_BUILD_NO_PROJECT`, `E_CLEAN_NO_PROJECT`, `E_DEV_NO_PROJECT`, `E_EXPLAIN_NO_PROJECT`, `E_GRAPH_NO_PROJECT`, `E_LIST_NO_PROJECT`, `E_NO_PROJECT`, `E_OUTDATED_NO_PROJECT`, `E_RUN_NO_PROJECT`, `E_TEST_NO_PROJECT`, `E_WHY_NO_PROJECT`, `E_WORKSPACES_NO_PROJECT`

## Project and configuration

| Code                        | Raised when                                                               |
| --------------------------- | ------------------------------------------------------------------------- |
| `E_PROJECT_FLAG_NOT_FOUND`  | `--project` points at a path that does not exist.                         |
| `E_PROJECT_NO_PLATFORMS`    | `compatibility.platforms` is missing or empty.                            |
| `E_PROJECT_NO_VERSIONS`     | `compatibility.versions` is missing or empty.                             |
| `E_REGISTRY_UNKNOWN_SCHEME` | A `registries` entry uses a scheme that is neither `https:` nor an alias. |

## Initialising a project

| Code                        | Raised when                                                                                      |
| --------------------------- | ------------------------------------------------------------------------------------------------ |
| `E_INIT_EXISTS`             | The target directory already holds a `project.json`.                                             |
| `E_INIT_DIR_NOT_EMPTY`      | The target directory has files and the run is non-interactive.                                   |
| `E_INIT_NESTED_PROJECT`     | The target sits inside an existing pluggy project.                                               |
| `E_INIT_UNKNOWN_TEMPLATE`   | `--template` names a template that does not exist. Run `pluggy templates`.                       |
| `E_INIT_UNKNOWN_MC_VERSION` | `--mc-version` names a version the chosen platforms do not publish. Run `pluggy platforms <id>`. |
| `E_INIT_VERSION_FETCH`      | The Minecraft version list could not be fetched. Pass `--mc-version` to skip the lookup.         |

## Dependency identifiers and sources

`E_IDENTIFIER_*` come from the command line (`pluggy install <here>`); `E_SOURCE_*` come from a `dependencies` entry in `project.json`. The distinction tells you which one to go fix.

| Code                                                                                         | Raised when                                                     |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `E_IDENTIFIER_EMPTY`                                                                         | The identifier argument was blank.                              |
| `E_IDENTIFIER_BAD_MODRINTH`                                                                  | A Modrinth slug uses characters slugs cannot contain.           |
| `E_IDENTIFIER_BAD_MAVEN`                                                                     | A `maven:` coordinate is not `group:artifact[@version]`.        |
| `E_IDENTIFIER_BAD_WORKSPACE`                                                                 | A `workspace:` reference names no declared workspace.           |
| `E_SOURCE_EMPTY`, `E_SOURCE_WHITESPACE`                                                      | A declared `source` is blank or padded.                         |
| `E_SOURCE_NO_SCHEME`, `E_SOURCE_UNKNOWN_SCHEME`                                              | A declared `source` has no scheme, or one pluggy does not know. |
| `E_SOURCE_BAD_MODRINTH`, `E_SOURCE_BAD_MAVEN`, `E_SOURCE_BAD_FILE`, `E_SOURCE_BAD_WORKSPACE` | A declared `source` is malformed for its scheme.                |

## Installing, updating, removing

| Code                               | Raised when                                                       |
| ---------------------------------- | ----------------------------------------------------------------- |
| `E_INSTALL_AT_ROOT_AMBIGUOUS`      | Installing one plugin at a workspace root without `--workspace`.  |
| `E_INSTALL_WORKSPACES_WITH_PLUGIN` | `--workspaces` combined with a single plugin argument.            |
| `E_REMOVE_NOT_DECLARED`            | The named dependency is not declared in scope.                    |
| `E_UPDATE_NOT_DECLARED`            | `pluggy update <name>` names something not declared.              |
| `E_UPDATE_TRANSITIVE`              | The name is a transitive; update the dependency that pulls it in. |

## Lockfile

| Code                                                                 | Raised when                                                 |
| -------------------------------------------------------------------- | ----------------------------------------------------------- |
| `E_LOCKFILE_PARSE`                                                   | `pluggy.lock` is not valid JSON.                            |
| `E_LOCKFILE_VERSION`                                                 | The lockfile version is newer than this pluggy understands. |
| `E_LOCKFILE_INVALID`                                                 | The lockfile's top-level shape is wrong.                    |
| `E_LOCKFILE_INVALID_ENTRY`                                           | An entry is missing required fields.                        |
| `E_LOCKFILE_INVALID_SOURCE`                                          | An entry's `source` is not a recognised source object.      |
| `E_AUDIT_NO_LOCKFILE`, `E_OUTDATED_NO_LOCKFILE`, `E_WHY_NO_LOCKFILE` | The command needs a lockfile. Run `pluggy install`.         |
| `E_WHY_NOT_FOUND`                                                    | No lockfile entry by that name.                             |

## Workspaces

| Code                               | Raised when                                                                  |
| ---------------------------------- | ---------------------------------------------------------------------------- |
| `E_WORKSPACE_NOT_FOUND`            | A named workspace is not declared.                                           |
| `E_WORKSPACE_NOT_SINGLE`           | More than one workspace was selected for a command that acts on one.         |
| `E_WORKSPACE_CYCLE`                | The `workspace:` dependency graph has a cycle. See `pluggy workspace graph`. |
| `E_WORKSPACE_MISSING_PROJECT_JSON` | A declared workspace directory has no `project.json`.                        |
| `E_WORKSPACE_NAME_COLLISION`       | `workspace add` reuses an existing workspace name.                           |
| `E_WORKSPACE_RENAME_COLLISION`     | `workspace rename` targets a name already in use.                            |
| `E_WORKSPACE_HAS_DEPENDENTS`       | Removing a workspace other workspaces depend on.                             |
| `E_WORKSPACE_DEP_NOT_BUILT`        | A `workspace:` dependency has no jar yet. Build it first.                    |
| `E_CONFIRM_REQUIRED`               | A destructive action needs `--yes` under `--json` or a non-TTY.              |

## Platforms

| Code                        | Raised when                                                           |
| --------------------------- | --------------------------------------------------------------------- |
| `E_PLATFORM_UNKNOWN`        | A platform id is not registered. Run `pluggy platforms`.              |
| `E_PLATFORM_NO_PLATFORMS`   | No platforms are registered at all (an internal failure).             |
| `E_PLATFORM_FAMILIES_MIXED` | One project mixes descriptor families that cannot share a descriptor. |

## Toolchain

| Code                                                        | Raised when                                                                    |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `E_DISCO_NO_MATCH`                                          | The distribution publishes no such major for this host. Run `pluggy sdk info`. |
| `E_DISCO_NO_DOWNLOAD`                                       | The upstream package has no download URL.                                      |
| `E_SDK_DOWNLOAD`                                            | The JDK download failed.                                                       |
| `E_SDK_INTEGRITY`                                           | The downloaded JDK did not match its published checksum.                       |
| `E_SDK_INSECURE_URL`                                        | The download URL was not HTTPS.                                                |
| `E_SDK_EXTRACT_LAYOUT`                                      | The JDK archive did not contain the expected layout.                           |
| `E_JBR_DOWNLOAD`, `E_JBR_INTEGRITY`, `E_JBR_EXTRACT_LAYOUT` | The same three failures for the JetBrains Runtime used by hotswap.             |

## Other

| Code                       | Raised when                                                                           |
| -------------------------- | ------------------------------------------------------------------------------------- |
| `E_BUILD_NOTHING_TO_BUILD` | Every selected workspace was skipped for having no `main`, so no jar was produced.    |
| `E_CLEAN_CACHE`            | `pluggy clean cache` was used; the global cache is cleared with `pluggy cache clean`. |
| `E_COMMAND_MOVED`          | A renamed command was called by its old name. The hint names the replacement.         |

## See also

- [`pluggy doctor`](./commands/doctor.md): reports environment problems before they become errors.
- [Troubleshooting](./troubleshooting.md): the common failures and what to do about them.
