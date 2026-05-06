package ${project.packageName};

import ${project.packageName}.listeners.JoinListener;

import org.bukkit.plugin.java.JavaPlugin;

/**
 * Main plugin class for ${project.name}.
 *
 * Wires a sample listener on enable. The whole lifecycle is exercised
 * by {@code ${project.className}Test} under {@code test/} via MockBukkit,
 * which boots a fake server in-process.
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
