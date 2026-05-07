package ${project.packageName}.commands;

import io.leangen.geantyref.TypeToken;

import org.spongepowered.api.Sponge;
import org.spongepowered.api.command.Command;
import org.spongepowered.api.event.EventListenerRegistration;
import org.spongepowered.api.event.Order;
import org.spongepowered.api.event.lifecycle.RegisterCommandEvent;
import org.spongepowered.plugin.PluginContainer;

/**
 * Registers Sponge commands.
 *
 * Sponge's {@code @Listener} scanner has a known issue resolving generic
 * event types (e.g. {@code RegisterCommandEvent<Command.Parameterized>}):
 * its ASM-based visitor sometimes drops the type argument and throws
 * {@code IllegalArgumentException: Incorrect number of type arguments…}.
 * The explicit {@link EventListenerRegistration} path uses a captured
 * {@link TypeToken} instead and bypasses the broken scanner.
 */
public final class CommandRegistrar {

    private static final TypeToken<RegisterCommandEvent<Command.Parameterized>> COMMAND_EVENT =
        new TypeToken<RegisterCommandEvent<Command.Parameterized>>() {};

    private CommandRegistrar() {}

    public static void register(final PluginContainer container) {
        Sponge.eventManager().registerListener(
            EventListenerRegistration.builder(COMMAND_EVENT)
                .plugin(container)
                .order(Order.DEFAULT)
                .listener(event -> event.register(container, HelloCommand.build(), "hello"))
                .build()
        );
    }
}
