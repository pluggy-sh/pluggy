package ${project.packageName};

import ${project.packageName}.listeners.JoinListener;

import org.bukkit.plugin.java.JavaPlugin;

/**
 * Main plugin class for ${project.name}.
 *
 * Demonstrates registering an event listener on enable. For a richer
 * scaffold with JUnit/MockBukkit tests, scaffold with
 * {@code pluggy init --template paper-mockbukkit} instead.
 */
public class ${project.className} extends JavaPlugin {

    @Override
    public void onEnable() {
        getServer().getPluginManager().registerEvents(new JoinListener(this), this);
        getLogger().info("${project.name} has been enabled!");
    }

    @Override
    public void onDisable() {
        getLogger().info("${project.name} has been disabled!");
    }
}
