package ${project.packageName}.api;

/**
 * Public surface of ${project.name}. Other plugins compile against this
 * interface; the implementation lives in the `core` workspace and is
 * loaded at runtime via {@link java.util.ServiceLoader} or a similar
 * registry.
 */
public interface PluginApi {

    /** Plugin version string (typically the workspace's `project.version`). */
    String version();
}
