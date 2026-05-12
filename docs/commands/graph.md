# `pluggy graph`

Render the workspace dependency graph. Output is text by default, optionally a Mermaid `graph TD` definition for pasting into Markdown.

The graph is derived from each workspace's `workspace:` dependencies (see [Workspaces: `workspace:` dependencies](../workspaces.md#workspace-dependencies)). Modrinth, Maven, and file sources don't appear: this command answers "what depends on what in this repo," not "what's on the classpath."

## Text output

```text
$ pluggy graph

Workspace graph
  api
  core ← api
  plugin ← api, core
```

The arrow reads "depends on." Nodes appear in [topological order](../glossary.md#topological-order), so each line's dependencies are listed above it.

## Mermaid output

```text
$ pluggy graph --mermaid
graph TD
  api["api"]
  core["core"]
  plugin["plugin"]
  core --> api
  plugin --> api
  plugin --> core
```

Paste the block into a GitHub Markdown file inside a fenced `mermaid` code block, and the graph renders inline. Workspace names containing `.` or `-` are sanitized to identifiers; the original name is preserved as the node label.

## JSON envelope

```json
{
  "status": "success",
  "exitCode": 0,
  "nodes": ["api", "core", "plugin"],
  "edges": [
    { "from": "core", "to": "api" },
    { "from": "plugin", "to": "api" },
    { "from": "plugin", "to": "core" }
  ]
}
```

The `mermaid` field is included when `--mermaid` is passed.

## Standalone projects

A project with no workspaces produces an empty graph. The command exits 0 and emits:

```text
No workspaces declared.
```

This is the right answer for single-`project.json` projects.

## See also

- [Workspaces](../workspaces.md): the layout and inheritance model.
- [`pluggy workspaces`](./workspaces.md): table listing of every workspace's role, platforms, and output path.
- [`pluggy explain`](./explain.md): per-workspace post-inheritance view.
