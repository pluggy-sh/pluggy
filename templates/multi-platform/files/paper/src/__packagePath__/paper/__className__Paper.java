package ${project.packageName}.paper;

import ${project.packageName}.api.PluginApi;
import ${project.packageName}.core.PluginCore;

import org.bukkit.plugin.java.JavaPlugin;

/**
 * Paper / Spigot entry point. Bukkit loads this class via plugin.yml,
 * which pluggy auto-generates from this workspace's `main` field. The
 * api + core jars are shaded into this jar at build time.
 */
public class ${project.className}Paper extends JavaPlugin {

    private PluginApi api;

    @Override
    public void onEnable() {
        this.api = new PluginCore(getPluginMeta().getVersion(), "Paper");
        getLogger().info("${project.name} v" + api.version() + " enabled on " + api.platformName());
    }
}
