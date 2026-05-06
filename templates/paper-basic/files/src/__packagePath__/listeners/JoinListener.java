package ${project.packageName}.listeners;

import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;
import org.bukkit.event.player.PlayerJoinEvent;
import org.bukkit.plugin.Plugin;

/** Greets joining players. */
public class JoinListener implements Listener {

    private final Plugin plugin;

    public JoinListener(Plugin plugin) {
        this.plugin = plugin;
    }

    @EventHandler
    public void onJoin(PlayerJoinEvent event) {
        var greeting = "Welcome to " + plugin.getName() + ", " + event.getPlayer().getName() + "!";
        event.getPlayer().sendMessage(greeting);
    }
}
