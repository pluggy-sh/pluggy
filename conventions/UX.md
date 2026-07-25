# User experience

This convention defines how the CLI should feel to the person typing it. The CLI is a capability graph: every command, subcommand, and flag is an edge, and a user finds what they need by following edges from what they already know. An edge that leads nowhere, or leads somewhere surprising, costs more than the feature it was added for. Examples are `pluggy` invocations, because the surface is where this is decided.

## Every capability is a reachable leaf

A distinct question gets a distinct command. Never hide a capability behind a boolean flag on a command that answers a different question.

`pluggy sdk list --available` listed installable JDK distributions from a command whose description was "Show cached JDKs": a different data set, one level below where anyone would look. Nobody found it. It became `pluggy sdk info`.

Ask: if a user did not already know this existed, what would they type? If the answer is "a flag on an unrelated command", it is in the wrong place.

## If pluggy knows a set, pluggy can list it

Any value the user must pick from a known set needs a command that prints that set. This holds hardest for sets that are large or fetched at runtime, which is exactly where it tends to be skipped.

```text
pluggy platforms          # what can I target
pluggy templates          # what can I scaffold from
pluggy sdk info temurin   # which JDK versions exist for this machine
```

The failure mode is subtle: the data is usually already in the process. `PlatformProvider.versions()` was used to pick a default and to _validate_ the user, so pluggy could say "paper does not publish version X" while offering no way to ask what paper does publish. Using a set to judge the user without showing it to them is the bug.

A small closed set can name itself inline instead: `--fallback <manual|restart|reload>` needs no command. Use `.choices()` so commander renders and validates it for free.

## One name, one meaning

A flag name has the same grammar and semantics on every command. A verb means the same thing in every namespace.

`--workspace` accepted a repeatable comma-separated list on five commands and a bare string on four others, so `--workspace a,b` looked up a workspace literally named "a,b" and `--workspace a --workspace b` silently took the last one. Same flag, two grammars, one of them silently wrong.

When a command genuinely acts on one target, accept the shared grammar and reject the arity with a real message. Do not invent a second grammar.

Multi-value flags are singular-named, repeatable, comma-separated, and validate every element.

## Validate against the set the value is actually used against

`search --platform` was checked against pluggy's platform registry, but the value goes to Modrinth as a loader facet. The two sets overlap and are not the same, so valid-looking input returned zero results as though nothing matched.

Validate at the edge, name the valid set in the error, and check it against the vocabulary of whatever consumes it.

## Errors diagnose the real cause and name the fix

An error has three jobs: say what is wrong, say why, and say what to do. The third is the one that gets skipped.

```text
before:  error [E_DISCO_HTTP]: Disco API 400 Bad Request: https://api.foojay.io/disco/v3.0/packages?distribution=temurin&version=99&…
           hint: Check connectivity to https://api.foojay.io and retry.

after:   error [E_DISCO_NO_MATCH]: temurin has no Java 99 for macos/aarch64
           hint: Available: 26, 25, 24, 23, 22, 21, 20, 17, 11. See `pluggy sdk info temurin`.
```

The first blames the network for a typo and leaks an internal URL. Never diagnose the wrong subsystem: a 4xx is the user's input, a 5xx is the transport. Never print internal vocabulary (`zip`, `staging`, `slot`, `envelope`) at a user. Spending one extra request on the failure path to name the valid options is worth it.

Every `code` is a public contract. Adding one means documenting it in `docs/error-codes.md`; the test suite enforces this in both directions.

## Nothing silently succeeds

Exit codes are truthful. `--json` always emits an envelope, including on failure.

Three separate bugs shared this shape: `init --version` printed pluggy's own version and created nothing while exiting 0; `pluggy workspace` wrote zero bytes to stdout and exited 0; `pluggy audit` passed on a cold cache having hashed nothing. Each looked like success to a script.

When a command reports a problem it cannot fix, that is still a failure. "I could not verify" is not "verified".

## Every state has a next step

A command that shows a problem should name the command that fixes it. A command that succeeds should name what comes next when there is an obvious next thing.

```text
✓ shop → bin/shop-2.0.0.jar (733 B, 732ms)
Run it: pluggy dev
```

Watch for terminal states in particular: an empty listing, a completed build, a check that only reports. `pluggy workspace` on a project with none told the user to hand-write a `workspaces` array while `workspace add` existed and did it correctly.

A hint must be runnable as printed. A template like `pluggy install <name>@<version>` produced a command that 404s for maven dependencies, because the lockfile key is the bare artifactId. Emit the concrete command, or none.

## Help text earns its place

Every string must change a decision. If a user cannot act differently for having read it, delete it.

- Do not restate the flag name. `--name <name>  "Project name."` says nothing.
- Do not describe the implementation. `--offline` sets a server property; what the user wants to know is that accounts can connect without Mojang authentication.
- Do not reassure. "The replacement is downloaded and verified before the old JDK is removed" describes a bug pluggy does not have.
- Do not let commander render a default twice. Passing a default _and_ writing it into the description prints it twice.

A footer that exists to tell two commands apart is evidence the names are wrong. `clean`'s help carried a table distinguishing it from `build --clean` and `dev --clean`; the fix was `pluggy clean [target]`, not a longer footer.

## Consistency is a feature, and its absence is a bug report

A user learns the shape once and expects it everywhere. When two commands in the same family behave differently, one of them is wrong even if both work.

`init` validated `--platform`, `--main`, and the version; `workspace add` validated none of them and wrote whatever it was given into `project.json`. Nothing was broken in isolation. Together they taught the user that validation is unpredictable.

When adding a command, find its nearest sibling and match it: flag names, grammar, output shape, exit codes, JSON envelope.

## Verify by driving, not by reading

Every claim about behaviour comes from running the binary. Build it, run it in `playground/`, and read the real output. Half the defects in this convention were invisible in the source and obvious the moment someone typed the command.

Check the interesting paths, not the happy one: the wrong value, the empty state, the second invocation, `--json`, a non-TTY, a cold cache.
