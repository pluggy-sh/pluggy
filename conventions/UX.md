# User experience

This convention defines how a command-line surface should feel to the person typing it. The principles are tool-agnostic; examples use a generic `tool` binary.

A CLI is a capability graph. Every command, subcommand, and flag is an edge, and a user finds what they need by following edges out from what they already know. An edge that leads nowhere, or somewhere surprising, costs more than the feature that added it.

## Every capability is a reachable leaf

A distinct question gets a distinct command. Never hide a capability behind a boolean flag on a command that answers a different question.

`tool cache list --remote` is not a variant of "list the cache". It queries a different data set and belongs at its own leaf, `tool cache remote`. A flag modifies how a command answers its question; it does not change the question.

Ask: if a user did not already know this existed, what would they type? If the answer is "a flag on an unrelated command", it is in the wrong place.

## If the program knows a set, the program can list it

Any value the user must pick from a known set needs a way to print that set. This matters most for sets that are large or fetched at runtime, which is exactly where it gets skipped.

The failure is easy to miss because the data is already in the process: code that validates input against a set necessarily holds that set. Rejecting `--region eu-west-9` while offering no way to ask which regions exist is using a set to judge the user without ever showing it to them.

A small closed set can name itself inline instead. `--mode <fast|safe>` needs no command, and a choices-aware option parser renders and validates it for free.

## One name, one meaning

A flag name has the same grammar and the same semantics on every command. A verb means the same thing in every namespace.

The dangerous version is not a different meaning, it is a different _grammar_. If `--target` takes a repeatable comma-separated list on some commands and a single string on others, then `--target a,b` looks up something named "a,b" and `--target a --target b` keeps only the last one. Both parse. Neither errors. Both are wrong.

When a command genuinely acts on one target, accept the shared grammar and reject the arity with a real message. Do not invent a second grammar.

Multi-value flags are singular-named, repeatable, comma-separated, and validate every element.

## Validate against the set the value is actually used against

A value is valid only with respect to the system that consumes it. When a flag is checked against a local list but forwarded to a remote API, the two sets drift apart, and input that passes validation comes back empty as though nothing matched.

Validate at the edge, against the vocabulary of whatever will consume the value, and name the valid set in the error.

## Errors diagnose the real cause and name the fix

An error has three jobs: say what is wrong, say why, and say what to do. The third is the one that gets skipped.

```text
before:  error: request failed (400): https://api.example.com/v3/packages?os=linux&arch=x64&version=99
           hint: check your connection and retry.

after:   error: version 99 is not published for linux/x64
           hint: available: 8, 11, 17, 21. Run `tool versions`.
```

The first blames the transport for a typo and leaks an internal URL. Do not diagnose the wrong subsystem: a 4xx is the caller's input, a 5xx is the transport. Do not print internal vocabulary (`zip`, `staging`, `slot`, `envelope`) at a user. Spending one extra request on the failure path to name the valid options is worth it.

Machine-readable error codes are a public contract. Document them, and let a test fail the build when a code is added without an entry.

## Nothing silently succeeds

Exit codes are truthful. Structured-output modes always emit their envelope, including on failure.

Three shapes account for most violations:

- A flag shadowed by a global one, so the command becomes a no-op that exits 0.
- A command that writes usage to stderr, nothing to stdout, and exits 0.
- A check that reports a problem it could not resolve and still exits 0.

Each looks like success to a script. "I could not verify" is not "verified".

## Every state has a next step

A command that reports a problem should name the command that fixes it. A command that succeeds should name what comes next when there is an obvious next thing.

Terminal states are where this is forgotten: an empty listing, a completed build, a check that only reports. An empty listing that tells the user to hand-edit a config file, when a command exists that edits it correctly, is a dead end with a workaround printed on it.

A hint must be runnable exactly as printed. A template like `tool install <name>@<version>` is not a hint, it is homework, and it is wrong for any entry whose display name differs from its install name. Emit the concrete command, or none.

## Help text earns its place

Every string must change a decision. If a user cannot act differently for having read it, delete it.

- Do not restate the flag name. `--name <name>  "The name."` says nothing.
- Do not describe the mechanism. Users want the effect: what changes for them, not which config key gets written.
- Do not reassure. A sentence explaining that an operation is safe describes a bug the tool does not have.
- Do not print a default twice. If the option parser renders defaults, do not also write them into the description.

A footer that exists to tell two commands apart is evidence the names are wrong. Fix the name; do not lengthen the footer.

## Consistency is a feature, and its absence is a bug report

A user learns the shape once and expects it everywhere. When two commands in the same family behave differently, one of them is wrong even if both work.

One command that validates its inputs and a sibling that writes whatever it is given are not two independent local choices. Together they teach the user that validation is unpredictable, which is worse than either behaviour on its own.

When adding a command, find its nearest sibling and match it: flag names, grammar, output shape, exit codes, structured-output envelope.

## Verify by driving, not by reading

Every claim about behaviour comes from running the thing. Build it, run it, read the real output.

Surface defects are routinely invisible in the source and obvious the moment someone types the command. Check the interesting paths, not the happy one: the wrong value, the empty state, the second invocation, structured output, a non-interactive terminal, a cold cache.
