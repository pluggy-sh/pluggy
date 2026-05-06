import { readFileSync } from "node:fs";

import { defineConfig } from "vite-plus";

/**
 * Source files import scaffolding bytes (Java stubs, YAML config) via the
 * standard `with { type: "text" }` attribute — Bun's `--compile` understands
 * that natively, but Vite/Vitest tries to parse the file as JS. Translate
 * those imports into raw-string exports so vitest can load `init.ts`.
 */
const textAssetExtensions = [".java", ".yml"];

export default defineConfig({
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {},
  test: {
    testTimeout: 120_000,
  },
  plugins: [
    {
      name: "pluggy:text-asset-imports",
      enforce: "pre",
      load(id: string) {
        const cleanId = id.split("?")[0];
        if (textAssetExtensions.some((ext) => cleanId.endsWith(ext))) {
          const raw = readFileSync(cleanId, "utf8");
          return `export default ${JSON.stringify(raw)};`;
        }
        return undefined;
      },
    },
  ],
});
