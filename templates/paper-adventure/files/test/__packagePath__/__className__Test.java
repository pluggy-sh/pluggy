package ${project.packageName};

import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.File;

import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.serializer.plain.PlainTextComponentSerializer;

import org.bukkit.plugin.Plugin;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockbukkit.mockbukkit.MockBukkit;
import org.mockbukkit.mockbukkit.ServerMock;

/**
 * Lifecycle test for ${project.name}. Verifies the Adventure-component
 * greeting reaches the player by deserialising the next message back to
 * plain text.
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
    void joinGreetingMentionsPlayer() {
        var alice = server.addPlayer("Alice");
        var raw = alice.nextMessage();
        assertNotNull(raw);
        // MockBukkit returns the legacy-serialised form; that's enough to
        // assert the player name and plugin name landed in the message.
        var text = PlainTextComponentSerializer.plainText().serialize(Component.text(raw));
        assertTrue(text.contains("Alice"));
        assertTrue(text.contains("${project.name}"));
    }
}
