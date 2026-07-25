# `pluggy platforms`

Show the server platforms you can target and the Minecraft versions each one publishes.

```text
$ pluggy platforms

Platforms you can target
  bukkit      26.2 — 73 versions, plugin.yml
  folia       26.1.2 — 11 versions, plugin.yml
  paper       26.2 — 66 versions, plugin.yml
  spigot      26.2 — 73 versions, plugin.yml
  sponge      26.2 — 53 versions, META-INF/sponge_plugins.json
  velocity    26.2 — 66 versions, velocity-plugin.json
  waterfall   1.21 — 11 versions, bungee.yml

Every version of one: pluggy platforms paper
```

Availability is queried per host. A platform that publishes a version for Linux but not for your OS and architecture will not offer it here.

## Usage

```text
pluggy platforms [platform]
```

Pass a platform to see every version it publishes, its descriptor file, and the command to start a project against it:

```text
$ pluggy platforms velocity

velocity
  descriptor:  velocity-plugin.json (velocity)
  latest:      26.2
  versions:    26.2, 26.2-rc-2, 26.1.2, 26.1.1, 1.21.11, …, 1.8.8, 1.7.10

Start a project: pluggy init --platform velocity --mc-version 26.2
```

Versions render newest first. `latest` comes from the platform's own "latest" endpoint rather than from either end of that list, because the upstream projects do not agree on an ordering.

## Why it exists

`pluggy doctor` validates `compatibility.versions` against these lists, and `pluggy init` picks its default from them. Before this command the lists were used to judge a project without ever being shown, so `paper does not publish version 26.9` had no follow-up question.

An unknown platform is rejected wherever it is accepted as input, and the error names the registered set:

```text
$ pluggy init --platform nonsuch
error: Invalid platform: "nonsuch". Available platforms: bukkit, spigot, paper, folia, velocity, waterfall, sponge
```

## Unreachable platforms

A platform whose upstream cannot be reached renders as `(unavailable)` rather than blanking the table, so one outage does not hide the rest.

## See also

- [`pluggy templates`](./templates.md): the scaffolds `init --template` accepts.
- [`pluggy init`](./init.md): `--platform` and `--mc-version`.
- [`project.json` reference](../project-json.md#compatibility): where the choice is recorded.
