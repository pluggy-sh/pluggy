# Build pipeline

A full walkthrough of what `pluggy build` does between reading `project.json` and writing the output jar. This page is for when you're debugging a weird build failure or when you need to understand why [shading](./glossary.md#shade) did what it did. For a hands-on intro, start with [Getting started](./getting-started.md).

## The high-level sequence

```text
┌───────────────┐   ┌───────────────┐   ┌───────────────┐
│  pick         │ → │  stage        │ → │  resolve      │
│  descriptor   │   │  directory    │   │  dependencies │
└───────────────┘   └───────────────┘   └───────────────┘
                                              │
                     ┌────────────────────────┘
                     ↓
┌───────────────┐   ┌───────────────┐   ┌───────────────┐
│  write IDE    │ → │  stage        │ → │  generate     │
│  files        │   │  resources    │   │  descriptor   │
└───────────────┘   └───────────────┘   └───────────────┘
                                              │
                     ┌────────────────────────┘
                     ↓
┌───────────────┐   ┌───────────────┐   ┌───────────────┐
│  compile      │ → │  apply        │ → │  zip          │
│  (javac)      │   │  shading      │   │  to jar       │
└───────────────┘   └───────────────┘   └───────────────┘
```

Each box corresponds to a module under `src/build/`.

## 1. Pick the descriptor

pluggy looks at `project.compatibility.platforms`. The first platform is _primary_. Every other platform must share the same [descriptor family](./glossary.md#descriptor-family) (same value of `descriptor.path`).

| Family     | Platforms                    | Path                           |
| ---------- | ---------------------------- | ------------------------------ |
| Bukkit     | paper, folia, spigot, bukkit | `plugin.yml`                   |
| BungeeCord | waterfall, travertine        | `bungee.yml`                   |
| Velocity   | velocity                     | `velocity-plugin.json`         |
| Sponge     | sponge                       | `META-INF/sponge_plugins.json` |

Mixed families fail with:

```text
build: project "<name>" declares platforms from different descriptor families ("paper" uses "plugin.yml", "velocity" uses "velocity-plugin.json"). Split them into separate workspaces, one per family.
```

## 2. Stage directory

```text
<workspace>/.pluggy-build/<hash>/
```

`<hash>` is the first 12 hex chars of `sha256(name \0 version \0 rootDir)`. Distinct projects don't collide. The same project always reuses the same staging directory so incremental `javac` output can be reused.

`--clean` removes the staging directory before the build. Without `--clean`, old output stays and `javac` overwrites only what it recompiled.

## 3. Resolve dependencies

Two resolve passes run in parallel:

- **Declared dependencies**: every entry in `project.dependencies`. Each one dispatches to the per-kind resolver in `src/resolver/`.
- **Platform API**: `getPlatform(primary).api(primaryVersion)` returns the Maven coordinate for `paper-api`, `velocity-api`, `spongeapi`, and friends. That's resolved with the platform's own Maven repo prepended to the project's registries (order-preserving dedup).

Every resolved dep produces:

```ts
{
  source: ResolvedSource,
  jarPath: string,           // absolute path in the user cache
  integrity: "sha256-<hex>",
  transitiveDeps: ResolvedDependency[]
}
```

Maven transitives are resolved recursively up to 8 levels deep. See [Dependencies > Maven transitive resolution](./dependencies.md#maven-transitive-resolution) for the rules (BOM import handling, `compile`/`runtime` scopes, unresolved `${...}` placeholders).

The classpath is the flattened list of jar paths: dep jars first, then the platform API jars, with order-preserving deduplication.

## 4. Write IDE files

Only if `project.ide` is set. Failures are caught and logged at `--verbose` (`build: IDE scaffolding failed (non-fatal): ...`) so a broken IDE integration doesn't block the build.

See [IDE integration](./ide.md) for what each `ide` value writes.

## 5. Stage resources

pluggy walks `project.resources`. For each entry:

- Keys ending in `/`: copy the source directory recursively, mirroring structure under the key as a prefix.
- Other keys: copy the source file to the key verbatim.

Templated extensions get `${project.x}` substitution before being written: `.yml`, `.yaml`, `.json`, `.properties`, `.txt`, `.md`. Binary files are hardlinked. Hardlink falls back to copy.

Output-path collisions are resolved "first wins" and subsequent declarations are skipped with a warning:

```text
⚠ resources: skipping "config.yml": an earlier entry already resolved to the same output path
```

## 6. Generate the descriptor

Unless a `resources` entry already targets the descriptor path, pluggy renders the descriptor from `project` and writes it to the staging dir.

### Bukkit family

Fields: `name`, `version`, `main`, `description` (if set), `api-version` (derived from `compatibility.versions[0]`: `"1.21.8"` becomes `"1.21"`), `authors` (as a YAML list).

### BungeeCord family

Fields: `name`, `version`, `main`, `description` (if set), `author` (singular, joined with `", "`).

### Velocity

Fields: `id` (derived from `name`: lowercased, non-alnum replaced with `-`, prefixed with `p-` if it starts with a non-letter), `name`, `version`, `main`, `description` (if set), `authors`.

### Sponge

Fields: `loader` (always `java_plain`), `id` (same derivation as Velocity), `name`, `version`, `main`, `description` (if set), `authors`. Written to `META-INF/sponge_plugins.json`.

Both YAML formats use a conservative scalar quoter that escapes values matching YAML reserved words (`true`, `false`, `yes`, `no`, `on`, `off`, `null`, `~`), numeric-looking strings, and values containing block-structure characters (`:`, `#`, `"`, `\n`, and so on).

## 7. Compile

```text
javac -encoding UTF-8 -d <staging> -cp <classpath> <source1> <source2> ...
```

Sources are every `*.java` under `<workspace>/src/`, recursive. The classpath separator is `:` on POSIX and `;` on Windows. pluggy uses Node's `path.delimiter` so the right one is picked for you.

No shell is spawned. `javac` is taken from the JDK pluggy provisioned for the project.

Stderr from `javac` is streamed to the terminal and buffered. The last 40 lines are included in the thrown error if `javac` exits non-zero:

```text
compile: javac exited with code 1 for project "my_plugin" (last 40 lines):
src/com/example/Main.java:12: error: cannot find symbol
    World world = server.getWorlds().get(0);
    ^
  symbol:   class World
  location: class Main
```

An empty source tree fails before `javac` is spawned:

```text
compile: no .java sources found under "<dir>" for project "<name>"
```

## 8. Apply shading

For each entry in `project.shading` (keyed by dep name, the same key the `dependencies` object uses), pluggy opens the dep jar with `yauzl` and walks its entries. Each entry is copied into the staging dir if and only if:

- It matches at least one pattern in `include` (default: `["**"]`), and
- It doesn't match any pattern in `exclude`.

Glob semantics:

- `*`: one path segment (no `/`).
- `**`: any depth including zero segments.
- `**/foo.txt`: `foo.txt` at any depth.
- `**/*.class`: every class file, any depth.

Leading `/` on either side is normalized away.

Dependencies without a shading entry are not shaded. They appear on the compile classpath but are not bundled into the jar. Your plugin expects them to be provided at runtime (for example by Paper).

### Shading a workspace sibling

Workspace deps are valid shading targets. The sibling must have been built already. Its jar lives at `<sibling>/bin/<name>-<version>.jar`. Running `pluggy build` from the repo root orders workspaces topologically, so this usually "just works."

From inside a workspace, the sibling won't be rebuilt for you, and shading errors:

```text
shade: workspace dependency "api" has not been built yet, expected jar at "/repo/api/bin/api-1.0.0.jar". Build the sibling workspace first (topological order is the caller's responsibility).
```

## 9. Zip

pluggy walks the staging directory, sorts entries lexicographically, and streams them into a zip with `yazl`. Entry paths are forward-slashed regardless of host OS. The output file is written to `<output>` (default `<workspace>/bin/<name>-<version>.jar`).

## Incremental builds

pluggy doesn't do fancy incremental compilation. The staging directory persists between runs, so `javac` only recompiles what it sees as changed. That's the fast path for an inner dev loop.

`--clean` wipes the staging directory, which effectively forces a full rebuild.

## Classpath semantics

The classpath includes:

1. Every declared dependency's jar.
2. For each declared dependency, its full transitive closure (depth-first).
3. The platform API jar and its transitive closure.

Duplicates are collapsed to the first occurrence, preserving order. `javac` sees exactly one copy of each jar.

Runtime-only dependencies (for example another plugin you depend on) are on the compile classpath so your code can reference its API. They're hardlinked into `dev/plugins/` during `pluggy dev` so they actually run. The output jar does not bundle them unless shading is configured.

## Output jar contents

```text
<name>-<version>.jar
├── plugin.yml                 (generated descriptor, or a user resource)
├── config.yml                 (from project.resources)
├── com/
│   └── example/
│       └── Main.class
└── net/kyori/adventure/...    (if shading is configured for adventure-api)
```

Exactly what you'd expect from a shaded plugin jar.

## See also

- [`pluggy build` reference](./commands/build.md): flags and output.
- [Dependencies](./dependencies.md): how the classpath gets populated.
- [IDE integration](./ide.md): how the classpath ends up in your editor.
- [Workspaces](./workspaces.md): topological build ordering.
