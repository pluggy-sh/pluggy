# `pluggy audit`

Verify every cached dependency jar against the [integrity hash](../glossary.md#integrity-hash) recorded in `pluggy.lock`. Catches tampering, accidental cache corruption, and mismatched lockfile entries before they reach a build.

```text
pluggy audit [--fix]
```

## Exit contract

`audit` exits 0 only when every locked dependency was hashed and matched. A dependency that isn't cached counts as unverified, not as passing, so a cold cache fails the gate instead of sailing through having hashed nothing.

| Row status | Meaning                                                                                    | Exit |
| ---------- | ------------------------------------------------------------------------------------------ | ---- |
| `ok`       | The cached jar's bytes match the lockfile.                                                 | 0    |
| `tampered` | The jar exists but hashes to something else.                                               | 1    |
| `missing`  | The jar isn't in the cache, so nothing was verified.                                       | 1    |
| `skipped`  | A `workspace:` dep. There's no cached jar; the sibling's own build is the source of truth. | 0    |

Only `skipped` rows are exempt. Everything else has to be hashed and matched.

## What it does

For every entry in `pluggy.lock`, pluggy:

1. Locates the jar in the cache (Modrinth, Maven, and file deps each have their own cache layout; workspace deps have none).
2. Reads the bytes and hashes them with SHA-256.
3. Compares against the entry's `integrity` field.

## `--fix`

`--fix` runs [`pluggy install`](./install.md) when any row came back `tampered` or `missing`, then hashes everything again. Without it, `audit` refetches nothing; it only checks bytes already on disk.

```text
$ pluggy audit --fix
  › Re-downloading unverified dependencies…
! Cached "adventure-api" at /Users/you/Library/Caches/pluggy/dependencies/maven/net.kyori/adventure-api/4.17.0.jar has unexpected integrity sha256-11d510e0… (lockfile expects sha256-15c8c2eb…); will re-resolve
  › Resolving net.kyori:adventure-api:4.17.0 from Maven…
✓ Installed 1 dependency

✓ 5 verified
```

The repair goes through the normal install path, so `--fix` re-resolves whatever install re-resolves. When install decides the lockfile is already fresh it prints `lockfile is fresh; nothing to install.` and the second audit reports the same rows as the first.

## Human output

A clean run:

```text
$ pluggy audit

✓ 6 verified
```

A dependency that isn't cached:

```text
$ pluggy audit

Unverified
  › net.kyori:examination-api (not cached)
Run `pluggy audit --fix` to download and verify them.

1 unverified (not cached), 1 verified, 1 skipped (workspace)
```

A tampered jar:

```text
$ pluggy audit

Tampered
✗ net.kyori:adventure-key
  expected: sha256-aaaa
  actual:   sha256-8e5cf570612d6ccedf943ac1716a449de2dd5a90207b7de6f73c0236935b766e
  jar:      /Users/you/Library/Caches/pluggy/dependencies/maven/net.kyori/adventure-key/4.17.0.jar
Run `pluggy install` to re-download; it detects tampering and heals the cache.

1 tampered, 1 verified
```

Both failure summaries keep the unverified and skipped counts when present. A lockfile with no entries prints `✓ no dependencies to verify`.

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
      "expected": "sha256-15c8…",
      "actual": "sha256-15c8…",
      "jarPath": "/Users/you/Library/Caches/pluggy/dependencies/maven/net.kyori/adventure-api/4.17.0.jar"
    }
  ]
}
```

When any row is `tampered` or `missing`, `status` is `"error"`, `ok` is `false`, the envelope goes to stderr, and the exit code is `1`.

## When to run

- **In CI** before `pluggy build`, after `pluggy install`. Running it on a cold cache fails by design; install first, then audit what install produced.
- **After `pluggy cache clean`** to confirm what survived. Everything reports unverified until you run `pluggy install` again.
- **When a build behaves strangely** and you want to rule out cache corruption.

## Error cases

| Trigger           | Code                  | Message                                                              |
| ----------------- | --------------------- | -------------------------------------------------------------------- |
| Outside a project | `E_AUDIT_NO_PROJECT`  | `No pluggy project found. Run this from inside a project directory.` |
| No lockfile       | `E_AUDIT_NO_LOCKFILE` | `No pluggy.lock found. Run pluggy install first.`                    |

Verification failures have no error code of their own. The row's `expected` and `actual` fields tell the story, and the exit code carries the verdict.

## See also

- [`pluggy install`](./install.md): re-resolve and re-download missing or stale entries.
- [`pluggy cache`](./cache.md): inspect or wipe the dependency cache.
- [Dependencies > Lockfile](../dependencies.md#lockfile): the integrity field's format.
