package ${project.packageName}.bungee;

import ${project.packageName}.api.PluginApi;
import ${project.packageName}.core.PluginCore;

import net.md_5.bungee.api.plugin.Plugin;

/**
 * BungeeCord proxy entry point. The bungee.yml descriptor is generated
 * by pluggy from this workspace's `main` field. The api + core jars are
 * shaded into this jar at build time.
 */
public class ${project.className}Bungee extends Plugin {

    private PluginApi api;

    @Override
    public void onEnable() {
        this.api = new PluginCore(getDescription().getVersion(), "BungeeCord");
        getLogger().info("${project.name} v" + api.version() + " enabled on " + api.platformName());
    }
}
