/**
 * `pluggy templates`: the scaffolds `pluggy init --template <id>` accepts.
 *
 * `listTemplates()` already existed and its only caller was `init`'s
 * interactive prompt, so the catalog was invisible under `--yes`, `--json`,
 * and every CI run — and a wrong `--template` id reported "not found in
 * fetched zip" without naming any of the ones that do exist.
 */

import { Command } from "commander";

import { bold, dim, emit, log } from "../logging.ts";
import { platforms } from "../platform/platform.ts";
import { listTemplates, type TemplateSummary } from "../templates/index.ts";

export interface TemplatesOptions {
  /** Show only templates whose family matches this platform's. */
  platform?: string;
}

export async function runTemplatesCommand(opts: TemplatesOptions = {}): Promise<TemplateSummary[]> {
  const all = await listTemplates();
  const family =
    opts.platform === undefined ? undefined : platforms.get(opts.platform).descriptor.family;
  const shown = family === undefined ? all : all.filter((t) => t.family === family);

  emit({ status: "success", templates: shown }, () => {
    if (shown.length === 0) {
      log.info(`No templates for ${opts.platform}.`);
      log.info(dim("Drop --platform to see all of them."));
      return;
    }

    log.heading(family === undefined ? "Templates" : `Templates for ${opts.platform}`);
    const width = Math.max(...shown.map((t) => t.id.length));
    let lastFamily: string | undefined;
    for (const template of shown) {
      if (family === undefined && template.family !== lastFamily) {
        log.info("");
        log.info(dim(`  ${template.family}`));
        lastFamily = template.family;
      }
      log.info(`  ${bold(template.id.padEnd(width))}  ${template.description}`);
    }
    log.info("");
    log.info(dim(`Use one: pluggy init --template ${shown[0]?.id}`));
  });

  return shown;
}

export function templatesCommand(): Command {
  return new Command("templates")
    .description("Show the project templates `pluggy init --template` accepts.")
    .option("--platform <id>", "Only templates that fit this platform.")
    .addHelpText(
      "after",
      "\nExamples:\n  $ pluggy templates\n  $ pluggy templates --platform velocity\n\nWithout --template, init scaffolds a minimal starter plugin.",
    )
    .action(async function action(this: Command, options) {
      await runTemplatesCommand({ platform: options.platform });
    });
}
