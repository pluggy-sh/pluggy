# Comments

A comment is a second source of truth. The code is the first, and it is the one that runs, so every comment is prose you must keep correct on every future change. At scale, comments that mirror the code are a parallel codebase: they drift, and a drifted comment does not just waste space, it lies. The default is **no comment**; each one that stays must carry information the code cannot.

## The test

Before writing a comment, ask: _does this say something true that the code cannot express?_

- The code already says it (a line, a value, a name, a structure), so the comment is **duplication**. Delete it; fix the code instead.
- It restates a value or name that lives elsewhere (a config, a constant, another function), so it is a **lie the moment that thing changes**. "Cached for 60s" is only honest if `60` is a literal in the same body, and even then prefer naming the literal over commenting it.
- It asserts something a reader cannot verify from the comment ("follows the spec", "this is correct", "implements X"), so it is a **lie-in-waiting**. To actually check, a reader holds the spec beside the code and reads line by line; the claim does not spare them that, and may already be false. Delete it.
- It states a real contract, a non-obvious _why_, or pending work, so it earns its place.

## What earns its place

1. **Contract, the _what_ for callers.** On a public or exported function, type, or module: its purpose, inputs, outputs, guarantees, and caveats, in the language's doc syntax (`/** */` TSDoc, `///` Rust, a doc comment above the declaration in Go, a docstring in Python). Document params and returns when they carry non-obvious meaning (units, constraints, nullability); skip the ones that only restate a name or type. Document the boundary; leave obvious internals bare. A `@deprecated` notice is part of the contract: say what to use instead and the exact version it is removed in (full semver, e.g. `v3.0.0`).
2. **Rationale, the _why_.** The non-obvious reason a line exists: a workaround, a constraint, a subtle invariant, a deliberate deviation. State the reasoning in full, in the comment, with no restatement of what the line does in front of it; a why must be understandable without leaving the file, and the reasoning is what earns the comment, not a link to where the reasoning lives. A reference is allowed only when its name carries the meaning: a standard (RFC-4122, ISO-8601), a named algorithm (Haversine), or a product and version (Safari 17.4). An opaque pointer to an internal artifact (a ticket, a design doc, another line) conveys nothing on its own, needs access you may not have, and rots. Justifying a constant counts: state the tradeoff (why larger or smaller is worse), not a bare benchmark number that silently goes stale.
3. **TODO, the _what's missing_.** A marker of known-incomplete or uncovered work. It states something the code cannot, that this is not done, and makes gaps and progress visible. Keep it specific enough to act on.

In tests, a short `given / when / then` scenario comment is fair when the setup is not self-evident; let the test name carry the headline.

## Never

- **How-narration.** Restating in prose what the next line does, including a "verb-it:" lead-in before a real reason (write the reason alone). The one exception is a genuinely opaque expression, a regex or a bit-trick, where the code truly cannot say what it means.
- **Meta / compliance.** "per CONVENTION.md", "the parser", "see design doc". Unverifiable and redundant: the reader must read the code anyway.
- **A constraint the code could enforce.** "must be between 0 and 1" is a missing guard, not documentation. Write the check (a clamp or an assert), or a TODO if you are deferring it.
- **Restated values or settings.** Any number, path, or name that is defined somewhere else. The definition is the source of truth; the copy goes stale silently.
- **Structural duplication.** A diagram or outline of the code's shape (e.g. the whole API tree atop a file). Now maintained in two places, and the comment drifts first.
- **Section banners.** `// ----- helpers -----` and the like. Decorative structure the file's own layout already provides; if a file needs banners to navigate, it wants splitting, not signposting.
- **Label-filler.** `// hack:`, `// note:`, `// best-effort:`. A category for the comment, not the comment. State the thing itself.
- **Code in comments.** Commented-out blocks; and changelog, attribution, or authorship, which are version control's job.

## Exceptions

Mandatory meta overrides the bans above, because tooling or policy requires the exact text:

- **License / legal headers** on released or static source. Prefer injecting them at build time; when the source ships as-is, a full header is correct.
- **Generated-file markers** (`Code generated ...; DO NOT EDIT.`). Tools and readers both depend on the line verbatim.

## Reach for names first

Most comments are a symptom: the code did not say what it meant. A better name, a type, or a smaller function beats an annotation; they are cheaper to maintain and self-verifying (the compiler checks a type, no one checks a comment). Units belong in the name (`timeoutSeconds`, not `timeout // seconds`). A comment is the last resort, not the first.

## Example

```ts
// how-narration + meta + structural duplication, delete all of it
// Built per CONVENTION.md.
// createSession -> accounts() -> get(id) -> balance()
function createSession(o) {
  const ctx = freeze({ ...o }); // build and freeze the context
  return session(ctx); // return the scope
}

/** Opens a session bound to `credentials`; throws if a required field is missing. */
function createSession(o: SessionOptions) {
  const ctx = Object.freeze(validate(o));
  return session(ctx);
}
```

The second carries one comment, a caller's contract, and nothing about _how_ the body works, because the body says that itself.
