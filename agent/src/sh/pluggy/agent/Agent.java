package sh.pluggy.agent;

import java.io.File;
import java.lang.instrument.Instrumentation;
import java.lang.management.ManagementFactory;
import java.lang.reflect.Method;
import java.net.URL;
import java.net.URLClassLoader;
import java.util.ArrayList;
import java.util.List;

/**
 * pluggy dev-server hotswap agent. Attaches via
 * {@code -javaagent:pluggy-agent.jar=roots=<pkg>@<dir>[;<pkg>@<dir>...]} and, on
 * a {@code reload} over the control socket, has {@link Reloader} redefine the
 * changed classes from every root's {@code <dir>}.
 *
 * One server JVM runs every plugin in a workspace suite, so the single agent
 * carries one {@link Root} per plugin: a package prefix (the plugin's classes)
 * paired with the dev-build directory those classes are compiled into.
 *
 * Depends only on {@code java.base} + {@code java.instrument} so the one jar
 * runs on every server family. Every failure path degrades to "no hotswap",
 * never a failed boot.
 */
public final class Agent {

  static volatile Instrumentation inst;
  static volatile Root[] roots = new Root[0];

  /** A plugin's watched package prefix paired with its dev-build classes dir. */
  static final class Root {
    /** Dotted package prefix; empty matches every class. */
    final String pkg;
    final String dir;
    volatile boolean spliced;

    Root(String pkg, String dir) {
      this.pkg = pkg;
      this.dir = dir;
    }

    boolean matches(String dottedName) {
      return pkg.isEmpty() || dottedName.startsWith(pkg);
    }
  }

  private Agent() {}

  public static void premain(String args, Instrumentation instrumentation) {
    try {
      inst = instrumentation;
      roots = parseRoots(arg(args, "roots"));
      for (Root r : roots) Reloader.seedDisk(r);
      instrumentation.addTransformer(new LoadHook(), true);

      String port = System.getProperty("pluggy.agent.port");
      if (port != null && !port.isEmpty()) {
        Thread t =
            new Thread(
                new Control(Integer.parseInt(port), System.getProperty("pluggy.agent.token")),
                "pluggy-agent-control");
        t.setDaemon(true);
        t.start();
      }
    } catch (Throwable t) {
      // An agent that throws in premain can abort JVM startup; never propagate.
    }
  }

  /** Redefine changed watched classes from disk. Called by the control thread. */
  public static Reloader.Result reloadNow() {
    return Reloader.reload(roots);
  }

  static boolean watched(String dottedName) {
    for (Root r : roots) {
      if (r.matches(dottedName)) return true;
    }
    return false;
  }

  /** The first root whose package owns this class, or null if none does. */
  static Root rootFor(String dottedName) {
    for (Root r : roots) {
      if (r.matches(dottedName)) return r;
    }
    return null;
  }

  /**
   * Add a root's classes dir to the plugin's own classloader, once. This is
   * what lets a hotswap introduce a *new* class: redefineClasses only replaces
   * already-loaded classes, but with the dir on the classloader's search path a
   * newly-referenced class loads lazily from disk instead of throwing
   * NoClassDefFoundError. Called from the transformer on the first load of a
   * class the root owns, so the loader is that plugin's own.
   */
  static synchronized void spliceClasspath(Root root, ClassLoader loader) {
    if (root == null || root.spliced || loader == null || root.dir.isEmpty()) return;
    if (!(loader instanceof URLClassLoader)) return; // Bukkit's PluginClassLoader is one
    try {
      URL url = new File(root.dir).toURI().toURL();
      Method addUrl = URLClassLoader.class.getDeclaredMethod("addURL", URL.class);
      addUrl.setAccessible(true);
      addUrl.invoke(loader, url);
      root.spliced = true;
    } catch (Throwable t) {
      // Best-effort: without the splice a hotswap can't add a new class, but
      // redefining existing ones still works.
    }
  }

  /** "pid@host" is the only portable PID source on Java 8. */
  static String pid() {
    try {
      String name = ManagementFactory.getRuntimeMXBean().getName();
      int at = name.indexOf('@');
      return at > 0 ? name.substring(0, at) : name;
    } catch (Throwable t) {
      return "?";
    }
  }

  /** Extract `key=value` from the comma-separated agent-arg string. */
  static String arg(String args, String key) {
    if (args == null || args.isEmpty()) return null;
    for (String part : args.split(",")) {
      int eq = part.indexOf('=');
      if (eq > 0 && key.equals(part.substring(0, eq).trim())) {
        return part.substring(eq + 1).trim();
      }
    }
    return null;
  }

  /** Parse a `;`-separated list of `pkg@dir` roots (pkg may be empty). */
  static Root[] parseRoots(String value) {
    if (value == null || value.isEmpty()) return new Root[0];
    List<Root> out = new ArrayList<Root>();
    for (String entry : value.split(";")) {
      String e = entry.trim();
      if (e.isEmpty()) continue;
      int at = e.indexOf('@');
      if (at < 0) continue;
      String pkg = e.substring(0, at).trim();
      String dir = e.substring(at + 1).trim();
      if (!dir.isEmpty()) out.add(new Root(pkg, dir));
    }
    return out.toArray(new Root[0]);
  }
}
