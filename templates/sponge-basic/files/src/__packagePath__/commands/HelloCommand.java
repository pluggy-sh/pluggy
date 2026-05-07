package ${project.packageName}.commands;

import net.kyori.adventure.text.Component;

import org.spongepowered.api.command.Command;
import org.spongepowered.api.command.CommandResult;
import org.spongepowered.api.command.parameter.Parameter;

/**
 * {@code /hello [name]} — replies with a greeting.
 *
 * Sponge exposes its own parameterised {@link Command} API on top of
 * Brigadier; that's the recommended way to declare commands since API 8.
 * The command builder is registered against the plugin container in the
 * main class's {@code RegisterCommandEvent} listener.
 */
public final class HelloCommand {

    private HelloCommand() {}

    public static Command.Parameterized build() {
        final Parameter.Value<String> name = Parameter.string().key("name").optional().build();

        return Command.builder()
            .addParameter(name)
            .executor(ctx -> {
                final String who = ctx.one(name).orElse("world");
                ctx.sendMessage(Component.text("Hello, " + who + "!"));
                return CommandResult.success();
            })
            .build();
    }
}
