# `pluggy audit`

Verify every cached dependency jar against the [integrity hash](../glossary.md#integrity-hash) recorded in `pluggy.lock`. Catches tampering, accidental cache corruption, and mismatched lockfile entries before they reach a build.

## Usage

```text
pluggy audit
```

## Flags

None beyond the global `--json`.

## What it does

For every entry in `pluggy.lock`, pluggy:

1. Locates the jar in the cache (Modrinth, Maven, and file deps each have their own cache layout; workspace deps don't have one).
2. Reads the bytes and hashes them with SHA-256.
3. Compares against the entry's `integrity` field.

Each entry is reported as one of:

- `ok`: the cached jar matches the lockfile.
- `tampered`: the jar exists but its hash differs from the lockfile. Exit code goes to `1`.
- `missing`: the jar isn't in the cache. Common after a `pluggy cache clean` or on a fresh checkout. Run `pluggy install` to repopulate.
- `skipped`: workspace deps. There's no cached jar to verify; the sibling's own build is the source of truth.

## Human output

A clean run:

```text
$ pluggy audit

✓ 6 verified
```

A clean run with one workspace dep and one missing entry:

```text
$ pluggy audit

Not cached
  · net.kyori:adventure-key (run pluggy install to populate)

✓ 5 verified, 1 skipped (workspace), 1 not cached
```

A failing run:

```text
$ pluggy audit

Tampered
  ✗ adventure-api
    expected: sha256-15c8c2eb1a69d8b1bc914f554353da8ee7cf074c05c8074da9898aee5c70d0d8
    actual:   sha256-deadbeef000...
    jar:      /Users/you/Library/Caches/pluggy/dependencies/maven/net/kyori/adventure-api/4.17.0.jar

1 tampered, 5 ok
```

## JSON output

```json
{
  "status": "success",
  "ok": true,
  "summary": { "ok": 6, "tampered": 0, "missing": 0, "skipped": 0 },
  "rows": [
    {
      "name": "adventure-api",
      "status": "ok",
      "expected": "sha256-15c8...",
      "actual": "sha256-15c8...",
      "jarPath": "/.../adventure-api/4.17.0.jar"
    }
  ]
}
```

When any entry is `tampered`, `status` is `"error"`, `ok` is `false`, the envelope goes to stderr, and the exit code is `1`. Missing or skipped entries on their own do not fail the command.

## When to run

- **In CI** before `pluggy build`. A failed audit means the cache was tampered with on the runner; investigate before building.
- **After `pluggy cache clean`** to confirm what survived (everything will report `missing` until you run `pluggy install` again).
- **When a build behaves strangely** and you want to rule out cache corruption.

`pluggy audit` does not refetch anything. It only checks bytes that are already on disk against the lockfile. To repopulate, run `pluggy install`.

## Error cases

| Trigger           | Code                  | Message                                                              |
| ----------------- | --------------------- | -------------------------------------------------------------------- |
| Outside a project | `E_AUDIT_NO_PROJECT`  | `No pluggy project found. Run this from inside a project directory.` |
| No lockfile       | `E_AUDIT_NO_LOCKFILE` | `No pluggy.lock found. Run pluggy install first.`                    |

A `tampered` row exits `1` with `status: "error"`. There's no special error code for tampered jars; the row's `expected` and `actual` fields tell the story.

## See also

- [`pluggy install`](./install.md): re-resolve and re-download missing or stale entries.
- [`pluggy cache`](./cache.md): inspect or wipe the dependency cache.
- [Dependencies > Lockfile](../dependencies.md#lockfile): the integrity field's format.
