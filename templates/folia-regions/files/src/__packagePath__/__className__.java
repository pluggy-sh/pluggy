package ${project.packageName};

import ${project.packageName}.services.HeartbeatService;

import java.time.Duration;

import org.bukkit.plugin.java.JavaPlugin;

/**
 * Main plugin class for ${project.name}.
 *
 * Folia replaces {@code BukkitScheduler} with three region-aware schedulers:
 *   - {@code getRegionScheduler()} — runs on the region thread that owns a
 *     given {@code Location} or {@code Entity}. Use this for anything that
 *     touches world state.
 *   - {@code getAsyncScheduler()} — fire-and-forget background work that
 *     never touches the world (DB queries, HTTP, file IO).
 *   - {@code getGlobalRegionScheduler()} — the rare task that needs the
 *     global thread, e.g. running on every region tick.
 *
 * On Folia, calling {@code Bukkit.getScheduler()} from a non-global thread
 * throws — use the right scheduler for the work, never the legacy one.
 */
public class ${project.className} extends JavaPlugin {

    private HeartbeatService heartbeat;

    @Override
    public void onEnable() {
        heartbeat = new HeartbeatService(this);
        heartbeat.start(Duration.ofSeconds(30));
        getLogger().info("${project.name} has been enabled!");
    }

    @Override
    public void onDisable() {
        if (heartbeat != null) {
            heartbeat.stop();
        }
        getLogger().info("${project.name} has been disabled!");
    }
}
