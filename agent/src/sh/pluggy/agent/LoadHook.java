package sh.pluggy.agent;

import java.lang.instrument.ClassFileTransformer;
import java.security.ProtectionDomain;

/**
 * Observes fresh loads of watched classes to baseline their bytes — so the
 * first reload only redefines classes that actually changed — and to splice
 * the classes dir into the plugin's classloader. Never rewrites bytecode.
 */
final class LoadHook implements ClassFileTransformer {

  @Override
  public byte[] transform(
      ClassLoader loader,
      String className,
      Class<?> classBeingRedefined,
      ProtectionDomain protectionDomain,
      byte[] classfileBuffer) {
    try {
      if (className == null || classBeingRedefined != null) return null;
      String dotted = className.replace('/', '.');
      Agent.Root root = Agent.rootFor(dotted);
      if (root == null) return null;
      Reloader.recordLoaded(dotted, classfileBuffer);
      Agent.spliceClasspath(root, loader);
    } catch (Throwable t) {
      // A transformer that throws can break class loading; never propagate.
    }
    return null;
  }
}
