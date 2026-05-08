# Migrating from a Maven or Gradle plugin project

If you already have a plugin project built with Maven or Gradle, pluggy can take over without a full rewrite. This recipe walks through the translation: what maps to what, what goes away, and what you'll still do by hand. It assumes you already understand how Maven or Gradle work; for first-time plugin authors, start with [Getting started](../getting-started.md) instead.

## What pluggy replaces

| Old world                                | pluggy equivalent                                     |
| ---------------------------------------- | ----------------------------------------------------- |
| `pom.xml` or `build.gradle`              | `project.json`                                        |
| `<dependencies>` or `implementation(...)`| `project.json:dependencies`                           |
| `<repositories>` or `repositories { }`   | `project.json:registries` (Maven only)                |
| `maven-shade-plugin` config              | `project.json:shading`                                |
| `mvn package` or `./gradlew shadowJar`   | `pluggy build`                                        |
| `mvn test` or `./gradlew test`           | `pluggy test` (JUnit Platform via `testDependencies`) |
| `plugin.yml` (hand-written)              | pluggy-generated, or staged via `resources`           |
| `src/main/java/`                         | `src/`                                                |
| `src/main/resources/`                    | `project.json:resources` mapping                      |
| IntelliJ/Eclipse import                  | `project.json:ide` (see [IDE integration](../ide.md)) |

## What pluggy does not do

- **Parent POMs.** pluggy's Maven resolver doesn't traverse parent POMs. If an upstream library uses one, property expansion can fail. Declare the missing transitives explicitly in `project.json`.
- **Class relocation in shading.** Moving `com.google.guava.*` to `your.plugin.guava.*` to avoid conflicts is not supported by pluggy's shading. Keep `maven-shade-plugin` or the Gradle shadow plugin, or open an issue.
- **Custom Gradle plugins.** Anything that mutates the build graph in unusual ways (custom source sets, AOT annotation processors beyond standard javac flags) isn't representable in `project.json`. Keep Gradle for those projects.

## Starting the migration

### 1. Stop Gradle/Maven

Move or rename the existing build files temporarily so pluggy doesn't get confused and so you don't trip over two build systems while migrating:

```bash
mv pom.xml pom.xml.old        # Maven
mv build.gradle build.gradle.old
mv build.gradle.kts build.gradle.kts.old
```

### 2. Scaffold a `project.json`

```bash
pluggy init --yes --name <your_name> --main com.your.Main --platform paper
```

If your project has a non-`src/main/java` source directory, you'll fix that in step 4.

### 3. Port dependencies

In your old `pom.xml`:

```xml
<dependency>
  <groupId>net.kyori</groupId>
  <artifactId>adventure-api</artifactId>
  <version>4.17.0</version>
</dependency>
```

Becomes:

```bash
pluggy install maven:net.kyori:adventure-api@4.17.0
```

Or edit `project.json` directly:

```json
"dependencies": {
  "adventure-api": {
    "source": "maven:net.kyori:adventure-api",
    "version": "4.17.0"
  }
}
```

Don't port the platform API dep (Paper's `paper-api`, Spigot's `spigot-api`, Velocity's `velocity-api`, Sponge's `spongeapi`). pluggy adds it automatically based on `compatibility.platforms[0]`.

Port Modrinth-sourced deps as well. If your Gradle build used the Modrinth Gradle plugin or a direct URL, switch to pluggy's Modrinth source kind:

```bash
pluggy install worldedit@7.3.15
```

### 4. Move sources

pluggy expects `<workspace>/src/<package>/<Class>.java`. Move from Maven's `src/main/java/com/example/` to `src/com/example/`:

```bash
mv src/main/java/com ./src/
```

Resources move too. If your Maven project had `src/main/resources/config.yml`,
declare it in `resources`:

```json
"resources": {
  "config.yml": "src/main/resources/config.yml"
}
```

Or move the file and update the path:

```bash
mv src/main/resources/config.yml src/config.yml
```

```json
"resources": {
  "config.yml": "src/config.yml"
}
```

### 5. Port shading

`maven-shade-plugin`:

```xml
<configuration>
  <artifactSet>
    <includes>
      <include>net.kyori:adventure-api</include>
    </includes>
  </artifactSet>
  <filters>
    <filter>
      <artifact>net.kyori:adventure-api</artifact>
      <includes>
        <include>net/kyori/adventure/api/**</include>
      </includes>
    </filter>
  </filters>
</configuration>
```

Becomes:

```json
"shading": {
  "adventure-api": {
    "include": ["net/kyori/adventure/api/**"]
  }
}
```

pluggy's shading is keyed by the dep **name** (the `dependencies` key), not the Maven coordinate. For Maven-sourced deps, the key is the `artifactId`, so `net.kyori:adventure-api` becomes `adventure-api`.

### 6. Port `plugin.yml`

pluggy generates a minimal `plugin.yml` from `project.name`, `project.version`, `project.main`, `project.description`, and derives `api-version` from `compatibility.versions[0]`. That's usually enough.

If your existing `plugin.yml` has `commands:`, `permissions:`, or `softdepend:` blocks pluggy doesn't model, stage it as a resource:

```json
"resources": {
  "plugin.yml": "src/plugin.yml"
}
```

The resource-staging code sees that you've claimed `plugin.yml` and skips the auto-generation step. Your hand-written file wins.

### 7. Port tests

If your old project ran tests with `mvn test` or `./gradlew test`, port them to `pluggy test`. Move sources from `src/test/java/` to `test/`, and declare every test-only dependency under `testDependencies` in `project.json`:

```json
"testDependencies": {
  "junit-jupiter": {
    "source": "maven:org.junit.jupiter:junit-jupiter",
    "version": "5.11.4"
  },
  "mockbukkit": {
    "source": "maven:org.mockbukkit.mockbukkit:mockbukkit-v1.21",
    "version": "4.90.0"
  }
}
```

JUnit Platform Console Standalone is auto-injected, so you never declare it. See [`pluggy test`](../commands/test.md) for the full command, and the [MockBukkit recipe](./testing-with-mockbukkit.md) for a worked example.

### 8. Port `project.compatibility`

Maven's `<properties>` with `<maven.compiler.target>21</maven.compiler.target>` is implicit in pluggy. The JDK pluggy provisions for your project is what `javac` targets, and `compatibility.versions[0]` drives the Minecraft version. The `api-version` line in `plugin.yml` is derived, not configured.

## A minimal before / after

### Before: Maven `pom.xml`

```xml
<project>
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.example</groupId>
  <artifactId>myplugin</artifactId>
  <version>1.0.0</version>
  <packaging>jar</packaging>

  <repositories>
    <repository>
      <id>papermc</id>
      <url>https://repo.papermc.io/repository/maven-public/</url>
    </repository>
  </repositories>

  <dependencies>
    <dependency>
      <groupId>io.papermc.paper</groupId>
      <artifactId>paper-api</artifactId>
      <version>1.21.8-R0.1-SNAPSHOT</version>
      <scope>provided</scope>
    </dependency>
    <dependency>
      <groupId>net.kyori</groupId>
      <artifactId>adventure-api</artifactId>
      <version>4.17.0</version>
    </dependency>
  </dependencies>
</project>
```

### After: pluggy `project.json`

```json
{
  "name": "myplugin",
  "version": "1.0.0",
  "main": "com.example.myplugin.Main",
  "compatibility": {
    "versions": ["1.21.8"],
    "platforms": ["paper"]
  },
  "registries": ["https://repo1.maven.org/maven2/"],
  "dependencies": {
    "adventure-api": {
      "source": "maven:net.kyori:adventure-api",
      "version": "4.17.0"
    }
  }
}
```

Note what went away:

- `paper-api`: inferred from `compatibility.platforms[0]`.
- PaperMC Maven repo: added automatically during resolve for Paper projects.
- `packaging`, `scope`, and `modelVersion`: pluggy has one output kind (plugin jar) and one scope model. Everything is compile-time on the classpath; shading decides what's bundled.

## Verify the translation

```bash
pluggy doctor   # config validation
pluggy build    # full compile, descriptor, shade, and zip
pluggy test     # if you ported tests
```

Compare the output jar contents with your old shaded jar:

```bash
unzip -l bin/myplugin-1.0.0.jar
```

`plugin.yml` should be present, `config.yml` should be present (if declared in `resources`), and any shaded classes should be under the expected paths.

## What your team needs to change

- **README.** Replace `mvn package` and `./gradlew build` with `pluggy build`. Replace `mvn clean` with `pluggy build --clean`. Replace `mvn test` with `pluggy test`.
- **CI.** See [CI without global pluggy](./ci-without-global-pluggy.md).
- **IDE import.** Set `"ide"` in `project.json`, run `pluggy build`, and open the repo in the target editor. No Maven or Gradle import flow.

## See also

- [project.json reference](../project-json.md): every field in detail.
- [Dependencies](../dependencies.md): the four source kinds.
- [Build pipeline](../build-pipeline.md): what pluggy actually does.
- [`pluggy test`](../commands/test.md): the test runner reference.
