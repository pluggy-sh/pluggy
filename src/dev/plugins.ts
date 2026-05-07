/**
 * Runtime plugin detection + `dev/plugins/` population. A dependency is a
 * *runtime plugin* iff its jar contains the primary platform's descriptor
 * file (e.g. `plugin.yml`); compile-time libraries are excluded from
 * `dev/plugins/` but stay on the build classpath.
 */

import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";

import yauzl from "yauzl";

import type { DescriptorSpec } from "../platform/platform.ts";
import { linkOrCopy } from "../portable.ts";
import type { ResolvedDependency } from "../resolver/index.ts";

/**
 * True iff the jar at `jarPath` contains an entry named `descriptor.path`.
 * Read-only — no extraction.
 */
export function isRuntimePlugin(jarPath: string, descriptor: DescriptorSpec): Promise<boolean> {
  return new Promise<boolean>((resolvePromise, rejectPromise) => {
    yauzl.open(jarPath, { lazyEntries: true }, (err, zip) => {
      if (err !== null || zip === undefined) {
        rejectPromise(
          new Error(
            `isRuntimePlugin: failed to open "${jarPath}": ${err?.message ?? "unknown error"}`,
          ),
        );
        return;
      }

      let found = false;
      zip.on("entry", (entry: yauzl.Entry) => {
        if (entry.fileName === descriptor.path) {
          found = true;
          zip.close();
          resolvePromise(true);
          return;
        }
        zip.readEntry();
      });

      zip.once("end", () => {
        if (!found) resolvePromise(false);
      });

      zip.once("error", (e: Error) => {
        rejectPromise(new Error(`isRuntimePlugin: error reading "${jarPath}": ${e.message}`));
      });

      zip.readEntry();
    });
  });
}

/**
 * Populate `<devDir>/<pluginsDir>/` with the user's plugin jar, every
 * runtime-plugin dep, and the `extraPlugins` jars. `pluginsDir` is the
 * platform's `runtime.pluginsDir` (e.g. `"plugins"` for bukkit,
 * `"mods/plugins"` for sponge) — forward-slashed and resolved relative to
 * `devDir`. Each jar is hardlinked (copy fallback) under its basename;
 * callers must ensure unique names.
 */
export async function stagePlugins(
  devDir: string,
  pluginsDir: string,
  ownJarPath: string,
  runtimeDeps: ResolvedDependency[],
  extraPlugins: string[],
): Promise<void> {
  const dest = join(devDir, ...pluginsDir.split("/"));
  await mkdir(dest, { recursive: true });

  await linkOrCopy(ownJarPath, join(dest, basename(ownJarPath)));

  for (const dep of runtimeDeps) {
    await linkOrCopy(dep.jarPath, join(dest, basename(dep.jarPath)));
  }

  for (const extra of extraPlugins) {
    await linkOrCopy(extra, join(dest, basename(extra)));
  }
}
