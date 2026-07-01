/**
 * The single source of truth for pluggy's version. Kept in a leaf module (no
 * imports) so anything can read it without pulling in the CLI entry point —
 * notably the platform-classpath cache, which folds it into its key so a
 * release that changes dependency resolution can't reuse a stale cache.
 */
export const CLI_VERSION = "0.0.0";
