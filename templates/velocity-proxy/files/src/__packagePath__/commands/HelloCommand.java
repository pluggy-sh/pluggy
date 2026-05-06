package ${project.packageName}.commands;

import com.mojang.brigadier.arguments.StringArgumentType;
import com.mojang.brigadier.builder.LiteralArgumentBuilder;
import com.mojang.brigadier.builder.RequiredArgumentBuilder;

import com.velocitypowered.api.command.BrigadierCommand;
import com.velocitypowered.api.command.CommandManager;
import com.velocitypowered.api.command.CommandSource;

import net.kyori.adventure.text.Component;

/**
 * {@code /hello [name]} — replies with a greeting on the proxy command bus.
 *
 * Velocity exposes Brigadier directly via {@link BrigadierCommand}; that's
 * the recommended way to register commands since 3.x.
 */
public final class HelloCommand {

    private HelloCommand() {}

    public static void register(CommandManager commandManager) {
        var node = LiteralArgumentBuilder.<CommandSource>literal("hello")
            .executes(ctx -> {
                ctx.getSource().sendMessage(Component.text("Hello!"));
                return 1;
            })
            .then(
                RequiredArgumentBuilder.<CommandSource, String>argument("name", StringArgumentType.word())
                    .executes(ctx -> {
                        var name = StringArgumentType.getString(ctx, "name");
                        ctx.getSource().sendMessage(Component.text("Hello, " + name + "!"));
                        return 1;
                    })
            )
            .build();

        commandManager.register("hello", new BrigadierCommand(node));
    }
}
