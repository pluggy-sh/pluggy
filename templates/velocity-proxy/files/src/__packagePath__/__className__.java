package ${project.packageName};

import ${project.packageName}.commands.HelloCommand;
import ${project.packageName}.listeners.ServerSwitchListener;

import com.google.inject.Inject;
import com.velocitypowered.api.event.Subscribe;
import com.velocitypowered.api.event.proxy.ProxyInitializeEvent;
import com.velocitypowered.api.plugin.Plugin;
import com.velocitypowered.api.proxy.ProxyServer;

import org.slf4j.Logger;

/**
 * Main plugin class for ${project.name}.
 *
 * Velocity discovers this class via {@code @Plugin}, builds it with Guice,
 * and dispatches lifecycle events through Velocity's event bus. Register
 * listeners and commands inside {@link #onProxyInitialize} — the proxy is
 * only ready then.
 */
@Plugin(
    id = "${project.velocityId}",
    name = "${project.name}",
    version = "${project.version}",
    description = "${project.description}"
)
public class ${project.className} {

    private final ProxyServer server;
    private final Logger logger;

    @Inject
    public ${project.className}(ProxyServer server, Logger logger) {
        this.server = server;
        this.logger = logger;
    }

    @Subscribe
    public void onProxyInitialize(ProxyInitializeEvent event) {
        server.getEventManager().register(this, new ServerSwitchListener(logger));
        HelloCommand.register(server.getCommandManager());
        logger.info("${project.name} has been enabled!");
    }
}
