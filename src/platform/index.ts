export * from "./platform.ts";

// Side-effect imports: each module calls createPlatform() at load time.
import "./spigot/bukkit.ts";
import "./spigot/spigot.ts";
import "./papermc/paper.ts";
import "./papermc/folia.ts";
import "./papermc/travertine.ts";
import "./papermc/velocity.ts";
import "./papermc/waterfall.ts";
import "./sponge/sponge.ts";
