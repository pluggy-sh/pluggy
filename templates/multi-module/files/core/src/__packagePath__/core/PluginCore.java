package ${project.packageName}.core;

import ${project.packageName}.api.PluginApi;

/**
 * Default implementation of {@link PluginApi}. The plugin workspace wires
 * this into the platform on startup; addons consume the api jar only.
 */
public class PluginCore implements PluginApi {

    private final String version;

    public PluginCore(String version) {
        this.version = version;
    }

    @Override
    public String version() {
        return version;
    }
}
