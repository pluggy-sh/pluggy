package ${project.packageName};

import com.google.inject.Inject;

import org.apache.logging.log4j.Logger;
import org.spongepowered.api.event.Listener;
import org.spongepowered.api.event.lifecycle.ConstructPluginEvent;
import org.spongepowered.plugin.builtin.jvm.Plugin;

/**
 * Main plugin class for ${project.name}
 *
 * Sponge constructs this class via Guice — the constructor's parameters are
 * dependency-injected. {@code @Listener} methods on the plugin class are
 * auto-registered against the plugin container. {@link ConstructPluginEvent}
 * is the canonical startup hook; later lifecycle events
 * ({@code StartedEngineEvent}, {@code StoppingEngineEvent}) hook engine
 * start/stop.
 */
@Plugin("${project.spongeId}")
public class ${project.className} {

    private final Logger logger;

    @Inject
    public ${project.className}(final Logger logger) {
        this.logger = logger;
    }

    @Listener
    public void onConstructPlugin(final ConstructPluginEvent event) {
        logger.info("${project.name} has been enabled!");

        // TODO: register listeners and commands here
    }
}
