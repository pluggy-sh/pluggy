package ${project.packageName}.core;

import ${project.packageName}.api.PluginApi;

/**
 * Default {@link PluginApi} implementation. Pure JVM — no platform deps.
 * Each shipping workspace constructs this with platform-specific values
 * and exposes it through that platform's plugin entry point.
 */
public class PluginCore implements PluginApi {

    private final String version;
    private final String platformName;

    public PluginCore(String version, String platformName) {
        this.version = version;
        this.platformName = platformName;
    }

    @Override
    public String version() {
        return version;
    }

    @Override
    public String platformName() {
        return platformName;
    }
}
