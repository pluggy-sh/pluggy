package ${project.packageName}.listeners;

import org.apache.logging.log4j.Logger;
import org.spongepowered.api.event.Listener;
import org.spongepowered.api.event.network.ServerSideConnectionEvent;

/**
 * Logs every successful player login. {@link ServerSideConnectionEvent.Join}
 * fires after the player has been added to the world, so {@code event.player()}
 * is always present.
 */
public class JoinListener {

    private final Logger logger;

    public JoinListener(final Logger logger) {
        this.logger = logger;
    }

    @Listener
    public void onJoin(final ServerSideConnectionEvent.Join event) {
        this.logger.info("{} joined", event.player().name());
    }
}
