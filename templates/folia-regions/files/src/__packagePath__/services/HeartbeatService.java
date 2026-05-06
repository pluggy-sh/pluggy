package ${project.packageName}.services;

import io.papermc.paper.threadedregions.scheduler.ScheduledTask;

import java.time.Duration;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import org.bukkit.plugin.Plugin;

/**
 * Periodically logs a heartbeat from the async scheduler. Demonstrates the
 * Folia pattern: pick a scheduler that matches the work. A heartbeat that
 * only logs is region-agnostic, so we use {@code getAsyncScheduler()}.
 *
 * To touch a specific region instead, call
 * {@code plugin.getServer().getRegionScheduler().run(plugin, location, ...)}
 * — that schedules onto the region thread that owns {@code location}.
 */
public class HeartbeatService {

    private final Plugin plugin;
    private final AtomicReference<ScheduledTask> task = new AtomicReference<>();

    public HeartbeatService(Plugin plugin) {
        this.plugin = plugin;
    }

    public void start(Duration interval) {
        // Folia's AsyncScheduler rejects initialDelay <= 0 with
        // IllegalArgumentException. Use one full interval as the first delay
        // so the heartbeat ticks at a steady cadence from t=interval onward.
        var periodMs = interval.toMillis();
        var scheduled = plugin.getServer().getAsyncScheduler().runAtFixedRate(
            plugin,
            t -> plugin.getLogger().fine(() -> plugin.getName() + " heartbeat"),
            periodMs,
            periodMs,
            TimeUnit.MILLISECONDS
        );
        var previous = task.getAndSet(scheduled);
        if (previous != null) {
            previous.cancel();
        }
    }

    public void stop() {
        var existing = task.getAndSet(null);
        if (existing != null) {
            existing.cancel();
        }
    }
}
