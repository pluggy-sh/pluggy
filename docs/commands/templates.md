# `pluggy templates`

Show the project templates [`pluggy init --template`](./init.md) accepts, grouped by descriptor family.

```text
$ pluggy templates

Templates

  bukkit
  paper-basic       Paper plugin with a sample listener — the simplest scaffold beyond the bare embedded stub.
  paper-mockbukkit  Paper plugin including listener + command + a JUnit/MockBukkit lifecycle harness driven by `pluggy test`.
  paper-adventure   Paper plugin that messages players via Adventure `Component`s.
  folia-regions     Folia plugin demonstrating `getRegionScheduler()` / `getAsyncScheduler()`.

  velocity
  velocity-proxy    Velocity proxy plugin with `@Inject` lifecycle, server-switch listener, and a Brigadier-registered command.

  bungee
  bungee-proxy      BungeeCord plugin with a `PostLoginEvent` listener and a registered Command.

  sponge
  sponge-basic      SpongeVanilla plugin with `@Plugin` lifecycle, a join listener, and a `/hello` command.

Use one: pluggy init --template paper-basic
```

Without `--template`, `init` scaffolds a minimal starter plugin embedded in the binary, which keeps it working offline.

## Usage

```text
pluggy templates [--platform <id>]
```

`--platform` narrows the list to templates whose family matches that platform:

```text
$ pluggy templates --platform velocity

Templates for velocity
  velocity-proxy  Velocity proxy plugin with `@Inject` lifecycle, server-switch listener, and a Brigadier-registered command.
```

## Unknown template ids

`init` checks the id before doing any work and names the ones that exist:

```text
$ pluggy init --template nonsuch
error [E_INIT_UNKNOWN_TEMPLATE]: No template named "nonsuch".
  hint: Available: paper-basic, paper-mockbukkit, …. Run `pluggy templates` for descriptions.
```

## Where templates come from

Templates are fetched from the pluggy repository. Two environment variables override that, documented in [cross-platform notes](../cross-platform.md#environment-variables): `PLUGGY_TEMPLATE_REPO` points at a different GitHub repo, and `PLUGGY_TEMPLATE_DIR` reads from a local directory instead.

## See also

- [`pluggy init`](./init.md): `--template` and the interactive picker.
- [`pluggy platforms`](./platforms.md): what you can target.
