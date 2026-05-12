package ${project.packageName}.velocity;

import ${project.packageName}.api.PluginApi;
import ${project.packageName}.core.PluginCore;

import com.google.inject.Inject;
import com.velocitypowered.api.event.Subscribe;
import com.velocitypowered.api.event.proxy.ProxyInitializeEvent;
import com.velocitypowered.api.plugin.Plugin;
import com.velocitypowered.api.plugin.PluginDescription;

import org.slf4j.Logger;

/**
 * Velocity proxy entry point. The {@code @Plugin} annotation seeds the
 * velocity-plugin.json that pluggy generates for this workspace. The
 * api + core jars are shaded into this jar at build time.
 */
@Plugin(
    id = "${project.velocityId}",
    name = "${project.name}",
    version = "${project.version}",
    description = "${project.description}"
)
public class ${project.className}Velocity {

    private final Logger logger;
    private final PluginDescription description;
    private PluginApi api;

    @Inject
    public ${project.className}Velocity(Logger logger, PluginDescription description) {
        this.logger = logger;
        this.description = description;
    }

    @Subscribe
    public void onProxyInitialize(ProxyInitializeEvent event) {
        this.api = new PluginCore(description.getVersion().orElse("?"), "Velocity");
        logger.info("${project.name} v{} enabled on {}", api.version(), api.platformName());
    }
}
