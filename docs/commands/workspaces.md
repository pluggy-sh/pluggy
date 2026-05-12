# `pluggy workspaces`

List every workspace declared in the current project: its role, target platforms, sibling dependencies, and output path. Read-only; use [`pluggy workspace`](./workspace.md) (singular) to mutate the graph.

## Usage

```text
$ pluggy workspaces

NAME              ROLE       PLATFORMS     DEPENDS-ON     OUTPUT
my-plugin-api     internal   paper,sponge  -              api/bin/my-plugin-api-0.1.0.jar
my-plugin-core    internal   paper,sponge  api            core/bin/my-plugin-core-0.1.0.jar
my-plugin-paper   shipping   paper         api, core      paper/bin/my-plugin-paper-1.0.0.jar
my-plugin-sponge  shipping   sponge        api, core      sponge/bin/my-plugin-sponge-1.0.0.jar
```

Rows appear in [topological order](../glossary.md#topological-order). `DEPENDS-ON` lists only workspaces in this repo; external Modrinth or Maven deps are intentionally omitted.

## Role

| Role       | Meaning                                                                                    |
| ---------- | ------------------------------------------------------------------------------------------ |
| `shipping` | Has a `main` class. Gets loaded by a platform server and produces a deployable plugin jar. |
| `internal` | Has no `main`. Library workspace consumed by siblings via `workspace:` deps.               |

## Standalone projects

A project with no `workspaces` declared exits 0 with an empty list:

```text
$ pluggy workspaces
No workspaces declared. (Add a `workspaces` array to project.json.)
```

The root project of a workspace-aware repo is not itself listed: it isn't a build target.

## JSON envelope

`--json` emits one object with a versioned envelope. We commit to the v1 shape; future additions append fields without breaking existing scripts.

```json
{
  "schemaVersion": 1,
  "workspaces": [
    {
      "name": "my-plugin-api",
      "rootDir": "/repo/api",
      "role": "internal",
      "main": null,
      "platforms": ["paper", "sponge"],
      "dependsOn": [],
      "outputPath": "/repo/api/bin/my-plugin-api-0.1.0.jar"
    }
  ]
}
```

`main` is `null` for internal workspaces and the FQCN string for shipping ones.

## See also

- [Workspaces](../workspaces.md): the layout and inheritance model.
- [`pluggy workspace add`](./workspace.md#add): create a new workspace.
- [`pluggy graph`](./graph.md): render the workspace dependency graph visually.
- [`pluggy explain`](./explain.md): show one workspace's post-inheritance view.
