# IDE integration

IDE setup is automatic. There is no `pluggy ide` command and nothing
to configure in `project.json`. This page documents what gets written,
why, and how to opt out.

## What pluggy writes

| When           | Files                                    | Lifetime                                                      |
| -------------- | ---------------------------------------- | ------------------------------------------------------------- |
| `pluggy init`  | `.idea/` + `<name>.iml`                  | Written once. pluggy never rewrites these after init.         |
| `pluggy build` | `.classpath` + `.project` (project root) | Regenerated on every build to reflect the resolved classpath. |

Pluggy never touches `.vscode/`. The `.classpath` is the single source
of truth — the same file feeds Eclipse, VS Code, and IntelliJ.

## How each IDE reads it

| IDE      | Mechanism                                                                                                     |
| -------- | ------------------------------------------------------------------------------------------------------------- |
| Eclipse  | Reads `.classpath` natively.                                                                                  |
| VS Code  | Reads `.classpath` via Red Hat's `vscode-java` extension (the "Extension Pack for Java" is the easy install). |
| IntelliJ | Reads `.classpath` because the `.idea/` stub `init` writes opens the project in linked-Eclipse mode.          |

That's why opening the project folder in any of the three "just works"
without an import wizard. After the first build, every IDE sees the
same dependency set.

## Opting out for a single build

```bash
pluggy build --skip-classpath
```

Skips the `.classpath` + `.project` write for one invocation. Useful in
CI when the IDE files would only churn the diff. There is no permanent
opt-out flag — the cost is a few microseconds and two small XML files.

## Version control

Don't check these into git:

```text
/.classpath
/.project
/.idea/
/*.iml
```

`.classpath` contains absolute paths into your local cache (under
`~/.cache/pluggy/` or the platform equivalent), which won't match
anyone else's machine. `pluggy init` adds these patterns to `.gitignore`
automatically.

## JDK picker (IntelliJ)

The `.idea/misc.xml` written at init names the project JDK by Java
major version, derived from `compatibility.versions[0]`:

| MC version       | JDK |
| ---------------- | --- |
| 1.21.x and later | 21  |
| 1.20.5 – 1.20.x  | 21  |
| 1.18.x – 1.20.4  | 17  |
| 1.17.x           | 16  |
| 1.16 and earlier | 8   |

IntelliJ honours `project-jdk-name="21"` if you have a JDK registered
under that name in `File > Project Structure > SDKs`. pluggy provisions
a matching JDK on the first build into `<cachePath>/jdk/temurin-<major>-<os>-<arch>/`;
run `pluggy sdk path 21` to print its absolute `JAVA_HOME` for IntelliJ
to pick up.

## Common failures

- **Red underlines despite a matching classpath.** Restart the Java
  language server. VS Code: `Java: Clean Java Language Server Workspace`.
  IntelliJ: `File > Invalidate Caches`.
- **Sibling workspace not on the classpath.** Workspace dependencies
  point at `<sibling>/bin/<name>-<version>.jar`. If the sibling hasn't
  been built, the jar doesn't exist. Build siblings first (running
  `pluggy build` from the repo root handles topological order for you).
- **IntelliJ wants a JDK you don't have.** `misc.xml` names the JDK by
  major version. Either install a matching JDK or edit `.idea/misc.xml`
  to point at one you have.

## See also

- [Build pipeline](./build-pipeline.md): where IDE scaffolding sits in the build.
- [`pluggy build --skip-classpath`](./commands/build.md): single-build opt-out.
