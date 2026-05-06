package ${project.packageName}.listeners;

import java.util.logging.Logger;

import net.md_5.bungee.api.event.PostLoginEvent;
import net.md_5.bungee.api.plugin.Listener;
import net.md_5.bungee.event.EventHandler;

/** Logs every successful login on the BungeeCord proxy. */
public class LoginListener implements Listener {

    private final Logger logger;

    public LoginListener(Logger logger) {
        this.logger = logger;
    }

    @EventHandler
    public void onPostLogin(PostLoginEvent event) {
        logger.info(() -> event.getPlayer().getName() + " logged in");
    }
}
