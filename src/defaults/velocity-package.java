package ${project.packageName};

import com.google.inject.Inject;
import com.velocitypowered.api.event.Subscribe;
import com.velocitypowered.api.event.proxy.ProxyInitializeEvent;
import com.velocitypowered.api.plugin.Plugin;
import com.velocitypowered.api.proxy.ProxyServer;

import org.slf4j.Logger;

/**
 * Main plugin class for ${project.name}
 *
 * Velocity discovers this class through the {@code @Plugin} annotation, then
 * builds it via Guice. The constructor's parameters are dependency-injected.
 * Lifecycle is event-driven: subscribe to {@code ProxyInitializeEvent} for
 * startup work and {@code ProxyShutdownEvent} for teardown.
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
        logger.info("${project.name} has been enabled!");

        // TODO: register listeners and commands here
    }
}
