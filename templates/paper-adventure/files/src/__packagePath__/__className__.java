package ${project.packageName};

import ${project.packageName}.listeners.AdventureJoinListener;

import org.bukkit.plugin.java.JavaPlugin;

/**
 * Main plugin class for ${project.name}.
 *
 * Adventure ships with Paper: import directly from
 * {@code net.kyori.adventure.text.Component} — no platform shim needed.
 */
public class ${project.className} extends JavaPlugin {

    @Override
    public void onEnable() {
        getServer().getPluginManager().registerEvents(new AdventureJoinListener(this), this);
        getLogger().info("${project.name} has been enabled!");
    }

    @Override
    public void onDisable() {
        getLogger().info("${project.name} has been disabled!");
    }
}
