/**
 * `pluggy platforms`: what you can target, and which Minecraft versions each
 * platform publishes.
 *
 * `PlatformProvider.versions()` already existed and was used in two places:
 * to pick `init`'s default, and to *validate* a project in `pluggy doctor`.
 * So pluggy would tell you "paper does not publish version X" while offering
 * no way to ask what paper does publish. This is that missing question.
 */

import process from "node:process";

import { Command } from "commander";

import { bold, dim, emit, log } from "../logging.ts";
import { platforms } from "../platform/platform.ts";

export interface PlatformSummary {
  id: string;
  descriptor: string;
  family: string;
  aliases: string[];
  /**
   * In the provider's own order. Providers don't agree on one (paper ascends,
   * spigot doesn't), so `latest` comes from `provider.latest()` rather than
   * from an assumption about either end of this list.
   */
  versions?: string[];
  latest?: string;
  error?: string;
}

export async function runPlatformsCommand(id?: string): Promise<PlatformSummary[]> {
  const ids = id === undefined ? platforms.list().sort() : [platforms.resolve(id) ?? id];
  if (id !== undefined) platforms.get(id); // throws E_PLATFORM_UNKNOWN, listing the known ids

  const aliasesById = new Map<string, string[]>();
  for (const [alias, target] of Object.entries(platforms.aliases())) {
    aliasesById.set(target, [...(aliasesById.get(target) ?? []), alias]);
  }

  const rows = await Promise.all(
    ids.map(async (platformId): Promise<PlatformSummary> => {
      const provider = platforms.get(platformId);
      const base = {
        id: platformId,
        descriptor: provider.descriptor.path,
        family: provider.descriptor.family,
        aliases: (aliasesById.get(platformId) ?? []).sort(),
      };
      try {
        const [versions, latest] = await Promise.all([provider.versions(), provider.latest()]);
        return { ...base, versions, latest: latest.version };
      } catch (err) {
        // One unreachable platform shouldn't blank the whole table.
        return { ...base, error: err instanceof Error ? err.message : String(err) };
      }
    }),
  );

  emit({ status: "success", platforms: rows }, () => {
    if (id !== undefined) {
      const row = rows[0];
      if (row === undefined) return;
      log.heading(row.id);
      if (row.aliases.length > 0)
        log.info(`  ${dim("also accepted as:")} ${row.aliases.join(", ")}`);
      log.info(`  ${dim("descriptor:")}  ${row.descriptor} (${row.family})`);
      log.info(`  ${dim("latest:")}      ${row.latest ?? dim("(unavailable)")}`);
      log.info(
        `  ${dim("versions:")}    ${row.versions?.join(", ") ?? dim(`(unavailable: ${row.error})`)}`,
      );
      if (row.latest !== undefined) {
        log.info("");
        log.info(
          dim(`Start a project: pluggy init --platform ${row.id} --mc-version ${row.latest}`),
        );
      }
      return;
    }

    log.heading("Platforms you can target");
    const width = Math.max(...rows.map((r) => r.id.length));
    for (const row of rows) {
      const detail =
        row.versions === undefined
          ? dim("(unavailable)")
          : `${row.latest ?? "?"} ${dim(`— ${row.versions.length} versions, ${row.descriptor}`)}`;
      log.info(`  ${bold(row.id.padEnd(width))}  ${detail}`);
    }
    log.info("");
    log.info(dim("Every version of one: pluggy platforms paper"));
  });

  return rows;
}

export function platformsCommand(): Command {
  return new Command("platforms")
    .description("Show the server platforms you can target and the versions they publish.")
    .argument("[platform]", "Show one platform in full.")
    .addHelpText("after", "\nExamples:\n  $ pluggy platforms\n  $ pluggy platforms paper")
    .action(async function action(this: Command, platform: string | undefined) {
      await runPlatformsCommand(platform);
      process.exitCode = 0;
    });
}
