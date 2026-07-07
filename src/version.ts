/**
 * The single source of truth for pluggy's version. Kept in a leaf module (no
 * imports) so anything can read it without pulling in the CLI entry point —
 * notably the platform-classpath cache, which folds it into its key so a
 * release that changes dependency resolution can't reuse a stale cache.
 */
// Annotated `string`, not the inferred literal: releases stamp a real
// version over "0.0.0", so narrowing on the literal would be wrong.
export const CLI_VERSION: string = "0.0.0";
