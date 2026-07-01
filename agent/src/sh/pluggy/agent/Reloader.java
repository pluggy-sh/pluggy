package sh.pluggy.agent;

import java.io.File;
import java.io.IOException;
import java.lang.instrument.ClassDefinition;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Reads changed `.class` files from the build's output directory and applies
 * them with {@link java.lang.instrument.Instrumentation#redefineClasses}.
 *
 * The result distinguishes three outcomes so pluggy can say something honest:
 *   - `reloaded`: loaded classes whose bytes changed were redefined live.
 *   - `pending`:  watched classes changed on disk but aren't loaded yet, so
 *                 there's nothing to redefine (a new class not referenced yet,
 *                 or code behind an unregistered listener). It applies when the
 *                 code runs (the classes dir is spliced into the loader) or on
 *                 a restart.
 *   - `nochange`: no watched class changed at all (a comment, whitespace, or a
 *                 resource-only edit).
 */
final class Reloader {

  /** Content hash of the last bytes we redefined into a loaded class. */
  private static final Map<String, String> lastHash = new HashMap<>();
  /** Content hash last seen on disk per watched class (loaded or not). */
  private static final Map<String, String> diskHash = new HashMap<>();

  private Reloader() {}

  static final class Result {
    final String status; // reloaded | pending | nochange | unsupported | error
    final int count; // classes redefined (reloaded) or changed-but-unloaded (pending)
    final String message;

    private Result(String status, int count, String message) {
      this.status = status;
      this.count = count;
      this.message = message;
    }

    static Result reloaded(int n) {
      return new Result("reloaded", n, null);
    }

    static Result pending(int n) {
      return new Result("pending", n, null);
    }

    static Result nochange() {
      return new Result("nochange", 0, null);
    }

    static Result unsupported(String msg) {
      return new Result("unsupported", 0, msg);
    }

    static Result error(String msg) {
      return new Result("error", 0, msg);
    }

    String wire() {
      if ("reloaded".equals(status) || "pending".equals(status)) return status + "\t" + count;
      if ("nochange".equals(status)) return "nochange";
      // Keep the reply to one tab-delimited line.
      return status + "\t" + String.valueOf(message).replace('\t', ' ').replace('\n', ' ');
    }
  }

  /** Baseline a class's bytes when it first loads, so we only redefine real changes. */
  static synchronized void recordLoaded(String dottedName, byte[] bytes) {
    String h = sha256(bytes);
    lastHash.putIfAbsent(dottedName, h);
    diskHash.putIfAbsent(dottedName, h);
  }

  /** Record every watched class currently on disk as the baseline (called at attach). */
  static synchronized void seedDisk(Agent.Root root) {
    if (root == null || root.dir == null || root.dir.isEmpty()) return;
    for (File f : classFiles(root.dir)) {
      String name = classNameOf(root.dir, f);
      if (name == null || !root.matches(name)) continue;
      byte[] bytes = read(f);
      if (bytes != null) diskHash.put(name, sha256(bytes));
    }
  }

  static synchronized Result reload(Agent.Root[] roots) {
    if (Agent.inst == null) return Result.error("no-instrumentation");
    if (roots.length == 0) return Result.error("no-classes-dir");

    // Which watched classes are currently loaded, by name.
    Map<String, Class<?>> loaded = new HashMap<>();
    for (Class<?> c : Agent.inst.getAllLoadedClasses()) {
      String n = c.getName();
      if (n != null && n.indexOf('[') < 0 && Agent.watched(n)) loaded.put(n, c);
    }

    List<ClassDefinition> defs = new ArrayList<>();
    Map<String, String> stagedLoaded = new HashMap<>();
    Map<String, String> stagedDisk = new HashMap<>();
    int pending = 0;

    for (Agent.Root root : roots) {
      for (File f : classFiles(root.dir)) {
        String name = classNameOf(root.dir, f);
        if (name == null || !root.matches(name)) continue;
        byte[] bytes = read(f);
        if (bytes == null) continue;
        String h = sha256(bytes);
        stagedDisk.put(name, h);

        Class<?> c = loaded.get(name);
        if (c != null) {
          if (!h.equals(lastHash.get(name))) {
            defs.add(new ClassDefinition(c, bytes));
            stagedLoaded.put(name, h);
          }
        } else if (!h.equals(diskHash.get(name))) {
          pending++;
        }
      }
    }

    if (defs.isEmpty()) {
      diskHash.putAll(stagedDisk);
      return pending > 0 ? Result.pending(pending) : Result.nochange();
    }

    try {
      Agent.inst.redefineClasses(defs.toArray(new ClassDefinition[0]));
    } catch (UnsupportedOperationException e) {
      return Result.unsupported(String.valueOf(e.getMessage()));
    } catch (Throwable t) {
      return Result.error(String.valueOf(t));
    }

    lastHash.putAll(stagedLoaded);
    diskHash.putAll(stagedDisk);
    return Result.reloaded(defs.size());
  }

  /** All `.class` files under `dir`, recursively. */
  private static List<File> classFiles(String dir) {
    List<File> out = new ArrayList<>();
    walk(new File(dir), out);
    return out;
  }

  private static void walk(File dir, List<File> out) {
    File[] entries = dir.listFiles();
    if (entries == null) return;
    for (File e : entries) {
      if (e.isDirectory()) walk(e, out);
      else if (e.getName().endsWith(".class")) out.add(e);
    }
  }

  /** Dotted class name for a `.class` file under `classesDir`, or null if outside. */
  private static String classNameOf(String classesDir, File f) {
    String base = new File(classesDir).getAbsolutePath();
    String path = f.getAbsolutePath();
    if (!path.startsWith(base)) return null;
    String rel = path.substring(base.length());
    if (rel.startsWith(File.separator)) rel = rel.substring(1);
    rel = rel.substring(0, rel.length() - ".class".length());
    return rel.replace(File.separatorChar, '.');
  }

  private static byte[] read(File f) {
    try {
      return Files.readAllBytes(f.toPath());
    } catch (IOException e) {
      return null;
    }
  }

  private static String sha256(byte[] bytes) {
    try {
      byte[] d = MessageDigest.getInstance("SHA-256").digest(bytes);
      StringBuilder sb = new StringBuilder(d.length * 2);
      for (byte b : d) {
        sb.append(Character.forDigit((b >> 4) & 0xf, 16)).append(Character.forDigit(b & 0xf, 16));
      }
      return sb.toString();
    } catch (Exception e) {
      return "len:" + bytes.length;
    }
  }
}
