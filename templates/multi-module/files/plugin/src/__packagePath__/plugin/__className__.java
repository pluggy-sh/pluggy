package ${project.packageName}.plugin;

import ${project.packageName}.api.PluginApi;
import ${project.packageName}.core.PluginCore;

import org.bukkit.plugin.java.JavaPlugin;

/**
 * Shipping entry point for ${project.name}. Bukkit loads this class via
 * the `main` field in plugin.yml; everything else lives in the api/core
 * workspaces and gets shaded in at build time.
 */
public class ${project.className} extends JavaPlugin {

    private PluginApi api;

    @Override
    public void onEnable() {
        this.api = new PluginCore(getPluginMeta().getVersion());
        getLogger().info("${project.name} v" + api.version() + " enabled");
    }
}
