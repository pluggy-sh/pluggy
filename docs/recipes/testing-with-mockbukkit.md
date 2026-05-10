# Testing a Paper plugin with MockBukkit

[MockBukkit](https://mockbukkit.org/) is the standard mocking framework for Bukkit and Paper plugins. It boots a fake `Server` in-process so you can test command handlers, event listeners, services, and the plugin's own lifecycle without spinning up a real Paper server.

`pluggy test` packages your plugin into a jar before running tests and hands the path off via a `pluggy.test.mainJar` system property. See [Mocking-framework hand-off](../commands/test.md#mocking-framework-hand-off) in the command reference. `MockBukkit.loadJar(...)` reads that property. The integration is not MockBukkit-specific.

## 1. Pick a MockBukkit version that matches your Paper API

MockBukkit publishes one artifact per Paper minor version. The artifact ID embeds the Minecraft version (`mockbukkit-v1.21`), and each release of that artifact targets a specific Paper API revision, readable from the `Paper-Version` line in the jar's `META-INF/MANIFEST.MF`.

Mismatched versions print:

```
################### MockBukkit Version Mismatch ###################
🔍 MockBukkit X.Y.Z (…) was built against Paper API version 1.21.N-R0.1-SNAPSHOT
```

For Paper 1.21.8, MockBukkit `4.90.0` is the last release that targets that exact API. 4.95.0 and later moved to 1.21.10 and 1.21.11. Check Maven Central metadata when picking a version:

```bash
curl -fsSL https://repo1.maven.org/maven2/org/mockbukkit/mockbukkit/mockbukkit-v1.21/maven-metadata.xml
```

## 2. Declare it as a `testDependency`

```json
{
  "name": "demo",
  "version": "1.0.0",
  "main": "com.example.demo.Main",
  "compatibility": {
    "versions": ["1.21.8"],
    "platforms": ["paper"]
  },
  "testDependencies": {
    "mockbukkit": {
      "source": "maven:org.mockbukkit.mockbukkit:mockbukkit-v1.21",
      "version": "4.90.0"
    }
  }
}
```

`testDependencies` is resolved against your `registries` plus an implicit Maven Central, so MockBukkit is fetched without any extra config. JUnit Platform Console Standalone is auto-injected. You never declare it.

## 3. Test the full plugin lifecycle

Load the plugin via the `pluggy.test.mainJar` system property, explicitly enable it (MockBukkit's `loadJar` does not auto-enable), and go.

```java
package com.example.demo;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.File;

import org.bukkit.plugin.Plugin;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockbukkit.mockbukkit.MockBukkit;
import org.mockbukkit.mockbukkit.ServerMock;

class MainPluginTest {

    private ServerMock server;
    private Plugin plugin;

    @BeforeEach
    void bootMockServer() {
        server = MockBukkit.mock();
        File jar = new File(System.getProperty("pluggy.test.mainJar"));
        plugin = MockBukkit.loadJar(jar);
        server.getPluginManager().enablePlugin(plugin);
    }

    @AfterEach
    void shutdown() {
        MockBukkit.unmock();
    }

    @Test
    void pluginEnables() {
        assertNotNull(plugin);
        assertTrue(plugin.isEnabled());
    }

    @Test
    void pluginNameMatches() {
        assertEquals("demo", plugin.getName());
    }

    @Test
    void canSpawnPlayers() {
        server.addPlayer("Alice");
        server.addPlayer("Bob");
        assertEquals(2, server.getOnlinePlayers().size());
    }
}
```

Run it:

```text
$ pluggy test
test demo
  com.example.demo.MainPluginTest
    ✓ canSpawnPlayers()  699ms
    ✓ pluginEnables()  5ms
    ✓ pluginNameMatches()  6ms

  3 passed
```

The first MockBukkit-using test in a class pays a one-time warm-up cost (around 700 ms). Subsequent tests in the same class are fast.

## 4. Loading other declared plugins

Every dep declared in `project.json` (`dependencies` or `testDependencies`) is exposed to tests as a system property. See [Mocking-framework hand-off](../commands/test.md#mocking-framework-hand-off) for the full property list. The two patterns you'll use most:

**Pick one by name** when a test cares about a specific dep:

```java
@Test
void integratesWithWorldEditWhenPresent() {
    File worldEdit = new File(System.getProperty("pluggy.test.dependency.worldedit"));
    MockBukkit.loadJar(worldEdit);
    plugin = MockBukkit.loadJar(new File(System.getProperty("pluggy.test.mainJar")));
    server.getPluginManager().enablePlugin(plugin);
    // ...assert your integration hook ran
}
```

**Boot everything** when you want a maximal "production-like" mock
server:

```java
@Test
void worksUnderFullStack() {
    for (String path : System.getProperty("pluggy.test.dependencies").split(File.pathSeparator)) {
        if (path.isEmpty()) continue;
        try { MockBukkit.loadJar(new File(path)); } catch (Exception ignored) {}
    }
    plugin = MockBukkit.loadJar(new File(System.getProperty("pluggy.test.mainJar")));
    server.getPluginManager().enablePlugin(plugin);
}
```

The catch is required because library jars (Maven deps that aren't plugins) appear in the catalog too, and `loadJar` errors with "no plugin.yml" on those.

Loading a real third-party plugin under MockBukkit can fail with `JavaPlugin requires a valid classloader` when that plugin's entry class is already on the runtime classpath. For coverage that only needs to detect "is plugin X loaded?", register a stub with the dep's name via `registerLoadedPlugin` instead of booting the real plugin.

## 5. Test handlers without booting the plugin

For tests that exercise listeners, commands, or services without needing the full plugin lifecycle, drive `ServerMock` directly. The plugin reference can be a fake (`MockBukkit.createMockPlugin()`) or the real one if you've already loaded it:

```java
class JoinListenerTest {

    private ServerMock server;
    private JoinListener listener;

    @BeforeEach
    void setUp() {
        server = MockBukkit.mock();
        listener = new JoinListener();
        server.getPluginManager().registerEvents(listener, MockBukkit.createMockPlugin());
    }

    @AfterEach
    void tearDown() {
        MockBukkit.unmock();
    }

    @Test
    void greetsJoiningPlayers() {
        var player = server.addPlayer("Alice");
        assertTrue(player.nextMessage().contains("Welcome"));
    }
}
```

`server.addPlayer()` synchronously fires `PlayerJoinEvent`, so the listener runs and the assertion against `nextMessage()` reads the greeting your code sent.

## Why `loadJar` and not `load(Main.class)`?

`pluggy test` does not put the plugin's entry-point class (`project.main`) on the runtime classpath. The compile classpath includes it (so test code can `import com.example.demo.Main`), but the runtime classpath has it stripped out. That keeps the system classloader from resolving the entry-point first, which would trip Bukkit's `JavaPlugin requires a valid classloader` check the moment MockBukkit tried to reload it through its own classloader.

Practical implications:

- `MockBukkit.loadJar(System.getProperty("pluggy.test.mainJar"))` works. It loads the plugin from the jar.
- `MockBukkit.load(Main.class)` does _not_ work in this layout. It requires `Main.class` on the runtime classpath, which pluggy holds back.
- Treat the loaded plugin as `Plugin` (or `JavaPlugin`) in your test variable types. Direct runtime references to `Main.class` or `new Main()` throw `NoClassDefFoundError` because the .class isn't on the runtime classpath.

Every other plugin class (utility classes, listeners, services) is on the runtime classpath as normal. Only the declared entry-point class is held back.

See [test command Caveats](../commands/test.md#caveats) for the mechanism.

## Cleaning up between runs

When you delete or rename a test file, the old `.class` is still in the test staging directory and JUnit will keep finding it. Run with `--clean` to wipe the staging dir:

```bash
pluggy test --clean
```

You don't need `--clean` for normal edit-and-rerun cycles. `javac` overwrites changed classes in place, and the main jars are regenerated every run.

## See also

- [`pluggy test`](../commands/test.md): full command reference, including the [mocking-framework hand-off](../commands/test.md#mocking-framework-hand-off) contract.
- [`project.json` reference](../project-json.md#testdependencies): declaring `testDependencies`.
- [MockBukkit documentation](https://mockbukkit.org/): upstream docs and API reference.
