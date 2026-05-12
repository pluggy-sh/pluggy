package ${project.packageName}.api;

/**
 * Public surface of ${project.name}. Platform-agnostic by design: addons
 * compile against this jar regardless of whether they target paper,
 * velocity, bungee, or sponge.
 */
public interface PluginApi {

    /** Plugin version reported back to consumers. */
    String version();

    /** Human-readable label for the platform the implementation is running on. */
    String platformName();
}
