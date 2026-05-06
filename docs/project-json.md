# `project.json` reference

The one file pluggy reads. Lives at the repo root, or at the root of each
workspace in a monorepo. pluggy walks up from the current directory until
it finds one, then (if workspaces are declared) walks back down to classify
which workspace you're sitting in.

## Shape

```json
{
  "name": "my_plugin",
  "version": "1.0.0",
  "description": "A small Paper plugin",
  "authors": ["Alice", "Bob"],
  "main": "com.example.myplugin.Main",
  "ide": ["vscode"],
  "compatibility": {
    "versions": ["1.21.8"],
    "platforms": ["paper"]
  },
  "registries": [
    "https://repo1.maven.org/maven2/",
    {
      "url": "https://maven.pkg.github.com/my-org/private",
      "credentials": {
        "username": "${GITHUB_ACTOR}",
        "password": "${GITHUB_TOKEN}"
      }
    }
  ],
  "dependencies": {
    "worldedit": {
      "source": "modrinth:worldedit",
      "version": "7.3.15"
    },
    "adventure-api": {
      "source": "maven:net.kyori:adventure-api",
      "version": "4.17.0"
    }
  },
  "shading": {
    "adventure-api": {
      "include": ["net/kyori/adventure/**"],
      "exclude": ["net/kyori/adventure/text/serializer/gson/**"]
    }
  },
  "resources": {
    "config.yml": "src/config.yml",
    "lang/": "src/lang"
  },
  "dev": {
    "port": 25565,
    "memory": "2G",
    "onlineMode": false,
    "jvmArgs": ["-XX:+UseG1GC"],
    "serverProperties": {
      "view-distance": 6,
      "spawn-protection": 0
    },
    "extraPlugins": ["./plugins/helper.jar"]
  },
  "workspaces": []
}
```

No field in this example is unique to that structure; you'll see them one
at a time below.

## Fields

### `name` (required)

String matching `^[a-zA-Z0-9_]+$`. Becomes the plugin's name in the
generated descriptor (`plugin.yml` / `bungee.yml` / `velocity-plugin.json`)
and the output jar stem (`<name>-<version>.jar`). `doctor` enforces the
regex; `init` rejects other characters.

### `version` (required)

String matching `^\d+\.\d+\.\d+(-[a-zA-Z0-9]+)?$`. Semver with an optional
prerelease tag, no build metadata. Embedded in the descriptor and the
output filename.

### `description` (optional)

Free-form string. Rendered into the descriptor when non-empty and inherited
from the workspace root when a workspace omits it.

### `authors` (optional)

Array of strings. In the Bukkit descriptor family each name becomes a
YAML list entry under `authors:`; BungeeCord uses a single `author:` field
joined with `", "`.

### `main` (required for plugin workspaces)

Fully-qualified Java class name, at least `package.Class`. pluggy uses this
for three things:

1. The descriptor's `main` field.
2. `${project.className}` / `${project.packageName}` template substitution
   in resource files and the initial Java class.
3. The output directory layout inside `src/` during `init`
   (`src/com/example/myplugin/Main.java`).

Required for every buildable workspace. A workspace-less root that declares
`workspaces` is not buildable itself and can omit `main`.

### `ide` (optional)

Array of `"vscode"`, `"eclipse"`, `"intellij"`. Controls which editor
scaffolding `build` writes — pluggy walks the array and generates files
for every listed IDE, so a mixed-editor team can commit one
`project.json` that covers everyone. Unset or empty means no scaffolding.
See [IDE integration](./ide.md) for what each value produces.

```json
"ide": ["vscode", "intellij"]
```

`pluggy init` writes this field from the interactive IDE checkbox; edit
the array by hand to add or remove editors later.

### `compatibility` (required)

```json
"compatibility": {
  "versions": ["1.21.8"],
  "platforms": ["paper"]
}
```

- `versions` — non-empty array of Minecraft versions. Both the legacy
  `1.21.8` shape and Mojang's 2026 calendar scheme (`26.1.2`) are accepted.
  The first entry is the primary version; it drives the platform API
  download, `api-version` in the Bukkit descriptor, and the JDK picker for
  IntelliJ. For `velocity`, this still reads as an MC version — pluggy
  resolves the actual `velocity-api` Maven coordinate internally to the
  latest stable Velocity release.
- `platforms` — non-empty array. The first entry is the primary platform.
  Every platform in the array must share the same descriptor family (same
  `plugin.yml` vs `bungee.yml` vs `velocity-plugin.json` target) — mixing
  families fails early with "Split them into separate workspaces — one per
  family."

The full platform roster ships with the binary:

| id           | descriptor             | Maven coordinate                           |
| ------------ | ---------------------- | ------------------------------------------ |
| `paper`      | `plugin.yml`           | `io.papermc.paper:paper-api`               |
| `folia`      | `plugin.yml`           | `dev.folia:folia-api`                      |
| `spigot`     | `plugin.yml`           | `org.spigotmc:spigot-api` (SNAPSHOT)       |
| `bukkit`     | `plugin.yml`           | `org.spigotmc:spigot-api` (SNAPSHOT)       |
| `velocity`   | `velocity-plugin.json` | `com.velocitypowered:velocity-api`         |
| `waterfall`  | `bungee.yml`           | `io.github.waterfallmc:waterfall-api`      |
| `travertine` | `bungee.yml`           | (no Maven API — compile against waterfall) |

Paper handles version strings in two formats. For 1.17 – 1.21.x the artifact
is `<version>-R0.1-SNAPSHOT`; for 26.x and later (Mojang's calendar scheme —
26.1, 26.1.1, 26.1.2) it's `<version>.build.<N>-alpha`. pluggy fetches
PaperMC's `maven-metadata.xml` and picks the highest matching entry, so you
write the plain MC version and pluggy works out the rest.

Spigot and Bukkit go through BuildTools, which decompiles the Mojang
server jar using the JDK on `PATH`. Different Minecraft releases require
different Java versions (MC 1.21.x allows Java 21 – 26; MC 26.1.x requires
Java 25 – 26). `pluggy init` reads each candidate's manifest and won't pin
your project to a version your Java can't actually compile.

### `registries` (optional)

Array of entries. Each entry is either:

- a bare URL string, or
- an object `{ "url": "...", "credentials": { "username": "...", "password": "..." } }`.

Registries apply to Maven dependencies. The Modrinth API is implicit and
doesn't need declaring. When credentials are set, `list` prints
`[authenticated]` next to the URL but never surfaces the values themselves —
they're read when the Maven resolver needs them.

The list is deduplicated by URL. In a monorepo, the root's registries are
unioned with each workspace's registries; duplicates drop.

### `dependencies` (optional)

Object keyed by dependency name. Each value is one of two shapes:

Short form — Modrinth slug shorthand:

```json
"dependencies": {
  "worldedit": "7.3.15"
}
```

Expands to `modrinth:worldedit@7.3.15`. The key is the slug.

Long form — explicit source:

```json
"dependencies": {
  "adventure-api": {
    "source": "maven:net.kyori:adventure-api",
    "version": "4.17.0"
  }
}
```

`source` accepts four schemes:

- `modrinth:<slug>` — slug matches `^[a-z0-9][a-z0-9\-_]*$`.
- `maven:<groupId>:<artifactId>` — both match `^[a-zA-Z][\w.-]*$`.
- `file:<path>` — absolute or repo-root-relative.
- `workspace:<name>` — sibling workspace. See [Workspaces](./workspaces.md).

The `version` field shape depends on the scheme:

| Scheme      | `version` meaning                                                                                            |
| ----------- | ------------------------------------------------------------------------------------------------------------ |
| `modrinth`  | Exact version number as listed on Modrinth, or `"*"` for latest.                                             |
| `maven`     | Maven version. Soft pins (`1.2.3`) and lower-bounded ranges (`[1.2,2.0)`) work; property expansion does not. |
| `file`      | Arbitrary label. The content-addressed integrity hash is what actually identifies the file.                  |
| `workspace` | Ignored. The sibling's own `project.json:version` wins.                                                      |

### `shading` (optional)

Object keyed by dependency name — same key you used in `dependencies`. Each
entry configures class-level inclusion into the final jar.

```json
"shading": {
  "adventure-api": {
    "include": ["net/kyori/adventure/api/**"],
    "exclude": ["net/kyori/adventure/api/internal/**"]
  }
}
```

- Omitting `include` is the same as `["**"]` (everything).
- `exclude` is subtracted after `include` matches.
- Patterns are forward-slashed jar-entry paths. `*` matches one segment;
  `**` matches any depth, including zero segments.
- Dependencies without a shading entry are not shaded. They're still on the
  compile classpath — they just don't end up inside your jar.

For `workspace:` sibling deps, `shading` uses the sibling's `name`, and the
build expects the sibling to have been built already. Running `pluggy build`
from the repo root orders workspaces topologically; running it from inside
a workspace doesn't, and the shade step errors with "has not been built
yet — expected jar at ...".

### `resources` (optional)

Object keyed by the output path inside the jar. Values are paths relative
to the project root.

```json
"resources": {
  "config.yml": "src/config.yml",
  "lang/": "src/lang"
}
```

Trailing `/` on a key means "copy the directory recursively". Files under
these extensions are run through `${project.x}` substitution before landing
in the jar: `.yml`, `.yaml`, `.json`, `.properties`, `.txt`, `.md`. Binary
files are hardlinked if possible, copied otherwise.

A `resources` entry that targets the descriptor path (`plugin.yml`,
`bungee.yml`, or `velocity-plugin.json`) takes precedence over pluggy's
auto-generated descriptor — useful when you need fields pluggy doesn't
model yet (`commands:`, `permissions:`, `softdepend:`, and so on).

On output-path collisions, the first-declared entry wins and subsequent
ones are skipped with a warning.

### `dev` (optional)

Knobs for `pluggy dev`.

```json
"dev": {
  "port": 25565,
  "memory": "2G",
  "onlineMode": false,
  "jvmArgs": ["-XX:+UseG1GC"],
  "serverProperties": {
    "view-distance": 6
  },
  "extraPlugins": ["./plugins/helper.jar"]
}
```

| Field              | Default | Notes                                                                                            |
| ------------------ | ------- | ------------------------------------------------------------------------------------------------ |
| `port`             | `25565` | `--port` overrides. Written to `server.properties`.                                              |
| `memory`           | `"2G"`  | JVM heap; produces `-Xmx<value>`. `--memory` overrides.                                          |
| `onlineMode`       | `false` | `--offline` on the command line forces `false` and beats the config.                             |
| `jvmArgs`          | `[]`    | Inserted between `-Xmx...` and `-jar server.jar`.                                                |
| `serverProperties` | `{}`    | Merged with pluggy's defaults (`motd`, `online-mode`, `server-port`). User keys win on conflict. |
| `extraPlugins`     | `[]`    | Jar paths relative to the workspace root; hardlinked into `dev/plugins/` at start.               |

`extraPlugins` is how you inject a runtime prerequisite that isn't in
`dependencies` (e.g., a locally-patched EssentialsX).

### `workspaces` (optional)

Array of paths (relative or absolute, forward-slashed) to sibling
`project.json` files. Each entry must point at a directory that contains a
`project.json`. See [Workspaces](./workspaces.md).

A project that declares `workspaces` is a root: it doesn't have to declare
`main`, it doesn't build a jar itself, and its `compatibility`, `authors`,
`description`, and `registries` are inherited by workspaces that don't
declare their own.

## Template variables

Several fields are substituted into files at build time. Syntax is
`${dotted.key}`; every scalar on the project object is available.

| Variable                              | Value                                        |
| ------------------------------------- | -------------------------------------------- |
| `${project.name}`                     | `name`                                       |
| `${project.version}`                  | `version`                                    |
| `${project.description}`              | `description`                                |
| `${project.main}`                     | `main`                                       |
| `${project.className}`                | Last segment of `main`                       |
| `${project.packageName}`              | Everything in `main` before the last segment |
| `${project.compatibility.versions.0}` | First entry of the versions array            |

Arrays expand to numerically-suffixed keys
(`${project.authors.0}`, `${project.authors.1}`, etc.).

Substitution runs on resources with the allowlisted extensions above and on
the `src/config.yml` + main-class templates produced by `init`.

## Validation

The primary validator is `pluggy doctor`, which checks:

- `name` matches `^[a-zA-Z0-9_]+$`.
- `version` matches `^\d+\.\d+\.\d+(-[a-zA-Z0-9]+)?$`.
- `compatibility.versions` and `compatibility.platforms` are non-empty arrays.
- Every entry in `compatibility.platforms` is a registered platform id.
- All workspaces share a descriptor family when they share a primary platform.
- Workspaces form a DAG (no cycles via `workspace:` deps).

Errors that would prevent a build show up here; warnings are advisory
(e.g. a JDK outside the 8 – 21 band when the primary platform is
`spigot`/`bukkit`).

## What pluggy does not read

- `package.json`, `pom.xml`, `build.gradle*` — ignored even if present.
- `settings.json`, `.idea/`, `.classpath` — pluggy writes these when
  `ide` is set, but never reads them.
- `pluggy.lock` is not `project.json`; it's a separate file produced by
  `install` and `build` and documented in [Dependencies](./dependencies.md#lockfile).
