package ${project.packageName}.listeners;

import com.velocitypowered.api.event.Subscribe;
import com.velocitypowered.api.event.player.ServerPostConnectEvent;

import org.slf4j.Logger;

/**
 * Logs every successful backend-server switch. Velocity dispatches
 * {@link ServerPostConnectEvent} on the proxy's worker pool — the handler
 * is free to do non-blocking work without a return value.
 */
public class ServerSwitchListener {

    private final Logger logger;

    public ServerSwitchListener(Logger logger) {
        this.logger = logger;
    }

    @Subscribe
    public void onServerSwitch(ServerPostConnectEvent event) {
        var player = event.getPlayer();
        var current = player.getCurrentServer().map(s -> s.getServerInfo().getName()).orElse("?");
        logger.info("{} → {}", player.getUsername(), current);
    }
}
