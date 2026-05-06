# IDE integration

Set `"ide"` in `project.json` to an array of editor kinds, and `pluggy
build` writes scaffolding so each IDE sees pluggy's resolved classpath.
Three values are supported:

| Value        | Produces                  | Consumer                           |
| ------------ | ------------------------- | ---------------------------------- |
| `"vscode"`   | `.vscode/settings.json`   | Red Hat's `vscode-java` extension  |
| `"eclipse"`  | `.classpath` + `.project` | Eclipse IDE / Spring Tools / Theia |
| `"intellij"` | `.idea/` + `<name>.iml`   | IntelliJ IDEA, CLion (Java plugin) |

Any subset is valid — list every editor your team uses:

```json
"ide": ["vscode", "intellij"]
```

Unset or empty `ide` means no scaffolding. `pluggy init` asks for this
interactively via a checkbox prompt.

## When the files are written

IDE scaffolding runs during `pluggy build`, right after dependencies are
resolved and right before resources are staged. Pass `--skip-classpath`
to suppress it for a single build without changing `project.json`.

If scaffolding fails (disk full, permissions), pluggy logs at
`--verbose`:

```text
◌ build: IDE scaffolding failed (non-fatal): EACCES: permission denied, open '.classpath'
```

The build continues — IDE files are advisory, not required.

## `"vscode"`

Writes `.vscode/settings.json`:

```json
{
  "java.project.referencedLibraries": [
    "/Users/you/Library/Caches/pluggy/dependencies/maven/net/kyori/adventure-api/4.17.0.jar",
    "/Users/you/Library/Caches/pluggy/dependencies/maven/net/kyori/adventure-key/4.17.0.jar",
    "..."
  ],
  "java.project.sourcePaths": ["src"],
  "java.project.outputPath": ".pluggy-build/classes"
}
```

Install the Red Hat `vscode-java` extension (the "Extension Pack for
Java" is the one-click option). On first open, VS Code indexes the
referenced libraries and you get completion, navigation, and inline
errors.

VS Code's Java tools use the cache paths directly — no project-local
`lib/` copy. That's intentional: if you bump a dep with `pluggy
install`, the next `pluggy build` rewrites `settings.json` and VS Code
picks up the new jars automatically.

**Verifying:** open the Java Project view in VS Code and expand
"Referenced Libraries". You should see one entry per resolved jar.

## `"eclipse"`

Writes two files at the project root:

- `.classpath` — every cache jar as a `<classpathentry kind="lib">`,
  plus a `<classpathentry kind="src" path="src"/>` and a JDT output path
  pointing at `.pluggy-build`.
- `.project` — minimal Eclipse project descriptor with the JDT nature.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<classpath>
  <classpathentry kind="src" path="src"/>
  <classpathentry kind="con" path="org.eclipse.jdt.launching.JRE_CONTAINER"/>
  <classpathentry kind="lib" path="/Users/you/Library/Caches/pluggy/dependencies/maven/net/kyori/adventure-api/4.17.0.jar"/>
  ...
  <classpathentry kind="output" path=".pluggy-build"/>
</classpath>
```

**Verifying:** `File > Import > Existing Projects into Workspace` and
pick the repo root.

## `"intellij"`

Writes a minimal working IntelliJ project at the root:

```text
.idea/
├── .gitignore
├── modules.xml
├── misc.xml
└── libraries/
    ├── maven__net_kyori__adventure-api__4_17_0.xml
    ├── maven__net_kyori__adventure-key__4_17_0.xml
    └── ...
<name>.iml
```

The naming rule for library files:

- Jars under the pluggy Maven cache become
  `maven__<groupId>__<artifactId>__<version>.xml` with dots replaced by
  underscores.
- Other jars fall back to the basename without `.jar`.
- Names are sanitized to `[A-Za-z0-9_.-]` only.
- Collisions get `__2`, `__3`, etc. suffixes in classpath order.

The `.iml` lists every library as an `orderEntry`, plus a single
`inheritedJdk` entry.

### JDK picker

`misc.xml` sets `project-jdk-name` and `languageLevel` from
`compatibility.versions[0]`:

| MC version       | JDK |
| ---------------- | --- |
| 1.21.x and later | 21  |
| 1.20.5 – 1.20.x  | 21  |
| 1.18.x – 1.20.4  | 17  |
| 1.17.x           | 16  |
| 1.16 and earlier | 8   |

Unparseable versions default to 21 (current Paper baseline). IntelliJ
honors `project-jdk-name="21"` if you have a JDK registered under that
name in `File > Project Structure > SDKs`.

pluggy provisions a matching JDK on the first build into
`<cachePath>/jdk/temurin-<major>-<os>-<arch>/`. Run
`pluggy sdk path 21` to print the absolute `JAVA_HOME` and register that
path in IntelliJ if no SDK is set up yet — see [`pluggy sdk`](./commands/sdk.md).

**Verifying:** `File > Open...` and point at the repo root. IntelliJ
should recognize it as an existing project and load the module without
any Gradle or Maven import flow.

## How the classpath stays fresh

IDE files are regenerated on every `pluggy build`. To refresh the IDE
view after `install`ing a new dep, run `pluggy build` (or `pluggy build
--skip-classpath false` — same thing explicitly).

If you're using the dev loop (`pluggy dev`), every rebuild updates the
IDE files in passing. You usually don't need to think about this.

## Version-control guidance

- `.vscode/settings.json` — check in. It only contains pluggy-managed
  classpath paths.
- `.classpath` + `.project` — don't check in. They contain absolute
  paths into your user cache, which won't match anyone else's machine.
- `.idea/` — don't check in. Same reason.
- `<name>.iml` — don't check in.

A sensible `.gitignore`:

```text
/.classpath
/.project
/.idea/
/*.iml
```

`.vscode/settings.json` is the only file in this set that stays
portable if your team is on the same platform and pluggy version —
worth checking in for team consistency. If your team is multi-OS, add it
to `.gitignore` too.

## Common failures

- **"Classpath seems to match but I see red underlines"** — restart the
  Java language server in your editor. In VS Code: `Java: Clean Java
Language Server Workspace`. In IntelliJ: `File > Invalidate Caches`.
- **"My sibling workspace isn't on the classpath"** — workspace
  dependencies point at `<sibling>/bin/<name>-<version>.jar`. If the
  sibling hasn't been built, the jar doesn't exist and the IDE sees an
  orphan entry. Build the sibling first.
- **"My IDE wants a JDK I don't have installed"** — the IntelliJ
  integration names the JDK by major version (`"21"`). Install a
  matching JDK or edit `.idea/misc.xml` manually.

## See also

- [project.json `ide` field](./project-json.md#ide-optional) — value
  reference.
- [`pluggy build --skip-classpath`](./commands/build.md) — temporarily
  disable scaffolding.
- [Build pipeline](./build-pipeline.md) — where IDE scaffolding sits.
