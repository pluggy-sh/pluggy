package ${project.packageName};

import ${project.packageName}.commands.HelloCommand;
import ${project.packageName}.listeners.LoginListener;

import net.md_5.bungee.api.plugin.Plugin;

/**
 * Main plugin class for ${project.name}.
 *
 * BungeeCord plugins extend {@link Plugin}. Register listeners via
 * {@code getProxy().getPluginManager().registerListener(this, ...)} and
 * commands via {@code registerCommand(this, ...)}; both are torn down
 * automatically on {@code onDisable}.
 */
public class ${project.className} extends Plugin {

    @Override
    public void onEnable() {
        var pm = getProxy().getPluginManager();
        pm.registerListener(this, new LoginListener(getLogger()));
        pm.registerCommand(this, new HelloCommand());
        getLogger().info("${project.name} has been enabled!");
    }

    @Override
    public void onDisable() {
        getLogger().info("${project.name} has been disabled!");
    }
}
