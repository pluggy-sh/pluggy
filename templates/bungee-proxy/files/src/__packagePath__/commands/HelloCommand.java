package ${project.packageName}.commands;

import net.md_5.bungee.api.CommandSender;
import net.md_5.bungee.api.chat.TextComponent;
import net.md_5.bungee.api.plugin.Command;

/** {@code /hello [name]} — proxy-side greeting on BungeeCord. */
public class HelloCommand extends Command {

    public HelloCommand() {
        super("hello");
    }

    @Override
    public void execute(CommandSender sender, String[] args) {
        var target = args.length > 0 ? args[0] : sender.getName();
        sender.sendMessage(new TextComponent("Hello, " + target + "!"));
    }
}
