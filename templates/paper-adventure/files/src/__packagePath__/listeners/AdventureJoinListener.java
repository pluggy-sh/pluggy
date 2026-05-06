package ${project.packageName}.listeners;

import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.format.NamedTextColor;

import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;
import org.bukkit.event.player.PlayerJoinEvent;
import org.bukkit.plugin.Plugin;

/**
 * Greets joining players with an Adventure {@link Component}. Using
 * components instead of legacy {@code §}-prefixed strings preserves
 * styling and clickable elements through Paper's modern message pipeline.
 */
public class AdventureJoinListener implements Listener {

    private final Plugin plugin;

    public AdventureJoinListener(Plugin plugin) {
        this.plugin = plugin;
    }

    @EventHandler
    public void onJoin(PlayerJoinEvent event) {
        var greeting = Component.text("Welcome to ", NamedTextColor.GRAY)
            .append(Component.text(plugin.getName(), NamedTextColor.GOLD))
            .append(Component.text(", ", NamedTextColor.GRAY))
            .append(Component.text(event.getPlayer().getName(), NamedTextColor.AQUA))
            .append(Component.text("!", NamedTextColor.GRAY));
        event.getPlayer().sendMessage(greeting);
    }
}
