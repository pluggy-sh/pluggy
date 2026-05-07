package ${project.packageName};

import com.google.inject.Inject;

import ${project.packageName}.commands.CommandRegistrar;
import ${project.packageName}.listeners.JoinListener;

import org.apache.logging.log4j.Logger;
import org.spongepowered.api.Sponge;
import org.spongepowered.api.event.Listener;
import org.spongepowered.api.event.lifecycle.ConstructPluginEvent;
import org.spongepowered.plugin.PluginContainer;
import org.spongepowered.plugin.builtin.jvm.Plugin;

/**
 * Main plugin class for ${project.name}.
 *
 * Sponge constructs the class through Guice — the {@link PluginContainer}
 * + {@link Logger} parameters are injected by the engine.
 *
 * Listeners live in their own classes and are registered against the
 * container from {@link ConstructPluginEvent}. We deliberately avoid
 * declaring generic-typed {@code @Listener} methods on the plugin class
 * itself — Sponge's plugin-class scanner doesn't always recover generic
 * parameter types from the bytecode signature, but
 * {@code Sponge.eventManager().registerListeners(...)} uses reflection
 * which works correctly.
 */
@Plugin("${project.spongeId}")
public class ${project.className} {

    private final PluginContainer container;
    private final Logger logger;

    @Inject
    public ${project.className}(final PluginContainer container, final Logger logger) {
        this.container = container;
        this.logger = logger;
    }

    @Listener
    public void onConstructPlugin(final ConstructPluginEvent event) {
        Sponge.eventManager().registerListeners(this.container, new JoinListener(this.logger));
        CommandRegistrar.register(this.container);
        this.logger.info("${project.name} has been enabled!");
    }
}
