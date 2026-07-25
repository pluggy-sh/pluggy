# `pluggy update`

Move declared dependencies to their latest upstream version, rewriting both `project.json` and `pluggy.lock`.

```text
$ pluggy update

Updated
  worldedit      7.4.3 → 7.4.4
  adventure-api  4.17.0 → 5.2.0

✓ 2 updated.
```

`pluggy update` changes your dependencies. [`pluggy upgrade`](./upgrade.md) replaces the pluggy binary. They are different commands, the same way `vp update` and `vp upgrade` are.

## Usage

```text
pluggy update [names...] [--beta] [--dry-run] [--workspace <name>] [--workspaces]
```

| Flag                 | Effect                                     |
| -------------------- | ------------------------------------------ |
| `--beta`             | Consider pre-release versions.             |
| `--dry-run`          | Print the plan and write nothing.          |
| `--workspace <name>` | Update only this workspace's dependencies. |
| `--workspaces`       | Update across every workspace.             |

With no names, every declared dependency that has an upstream is updated. Name one or more to narrow it:

```text
$ pluggy update worldedit
```

## Checking first

```text
$ pluggy update --dry-run

Would update
  worldedit  7.4.3 → 7.4.4

Re-run without --dry-run to apply.
```

[`pluggy outdated`](./outdated.md) answers the same question in more detail, including transitive entries, and points here.

## What cannot be updated

**Transitive dependencies** are not declared by you, and `install` only writes top-level entries. Naming one tells you which dependency to update instead:

```text
$ pluggy update net.kyori:adventure-key
error [E_UPDATE_TRANSITIVE]: "net.kyori:adventure-key" is a transitive dependency, not one you declared.
  hint: Update the dependency that pulls it in: pluggy update adventure-api
```

**File and workspace dependencies** have no upstream version. A `file:` dependency tracks the jar on disk; a `workspace:` dependency tracks its sibling's `project.json`. Both are skipped.

## Pinning instead

`update` always takes the newest version. To move to a specific one, install it by name:

```text
$ pluggy install worldedit@7.4.2
```

## See also

- [`pluggy outdated`](./outdated.md): what's stale, including transitives.
- [`pluggy install`](./install.md): add a dependency, or pin an exact version.
- [`pluggy upgrade`](./upgrade.md): update pluggy itself.
