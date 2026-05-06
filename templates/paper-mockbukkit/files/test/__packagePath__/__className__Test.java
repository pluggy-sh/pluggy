package ${project.packageName};

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

/**
 * Lifecycle test for ${project.name}. Loads the built plugin jar via
 * the {@code pluggy.test.mainJar} system property — that hand-off is
 * documented in {@code docs/recipes/testing-with-mockbukkit.md}.
 */
class ${project.className}Test {

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
        assertEquals("${project.name}", plugin.getName());
    }

    @Test
    void joinListenerGreetsPlayer() {
        var alice = server.addPlayer("Alice");
        var greeting = alice.nextMessage();
        assertNotNull(greeting);
        assertTrue(greeting.contains("Welcome"));
        assertTrue(greeting.contains("Alice"));
    }
}
