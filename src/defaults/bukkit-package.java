package ${project.packageName};

import org.bukkit.plugin.java.JavaPlugin;

/**
 * Main plugin class for ${project.name}
 * 
 * This class serves as the entry point for your Minecraft plugin.
 * It extends JavaPlugin and provides lifecycle methods for enabling
 * and disabling your plugin.
 */
public class ${project.className} extends JavaPlugin {
    
    /**
     * Called when the plugin is enabled
     * 
     * This method is called after the plugin has been loaded and
     * should be used to register events, commands, and initialize
     * your plugin's functionality.
     */
    @Override
    public void onEnable() {
        getLogger().info("${project.name} has been enabled!");

        // TODO: Initialize your plugin here
    }
    
    /**
     * Called when the plugin is disabled
     * 
     * This method is called when the plugin is being disabled and
     * should be used to clean up resources, save data, and perform
     * any necessary shutdown procedures.
     */
    @Override
    public void onDisable() {
        getLogger().info("${project.name} has been disabled!");

        // TODO: Clean up resources here
    }
}