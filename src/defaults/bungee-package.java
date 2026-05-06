package ${project.packageName};

import net.md_5.bungee.api.plugin.Plugin;

/**
 * Main plugin class for ${project.name}
 *
 * BungeeCord plugins extend {@link Plugin} directly. Override {@code onEnable}
 * to register listeners and commands via {@code getProxy().getPluginManager()},
 * and {@code onDisable} to release any resources you held.
 */
public class ${project.className} extends Plugin {

    @Override
    public void onEnable() {
        getLogger().info("${project.name} has been enabled!");

        // TODO: register listeners and commands here
    }

    @Override
    public void onDisable() {
        getLogger().info("${project.name} has been disabled!");

        // TODO: release resources here
    }
}
