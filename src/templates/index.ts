/**
 * Template source resolution + instantiation. Templates live at
 * `templates/<id>/` in the pluggy repo (or any fork pointed at via the
 * `PLUGGY_TEMPLATE_REPO` / `PLUGGY_TEMPLATE_DIR` env vars). At init time we
 * either:
 *
 *   - read straight from a local `templates/` dir (when `PLUGGY_TEMPLATE_DIR`
 *     is set, used by tests and by working copies of the pluggy repo
 *     itself), or
 *   - fetch the repo as a zip from `codeload.github.com`, parse it with
 *     yauzl, and pull out only the requested template's subtree.
 *
 * Filename substitution (`__packagePath__` / `__className__`) and content
 * substitution (`${project.x}`) both happen here so callers receive
 * ready-to-write {@link TemplateFile}s.
 */

import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import process from "node:process";

import yauzl, { type Entry, type ZipFile } from "yauzl";

import type { PlatformFamily } from "../platform/index.ts";
import { replace } from "../template.ts";

const DEFAULT_REPO = "pluggy-sh/pluggy";
const DEFAULT_REF = "main";

/** Lightweight entry as listed in `templates/index.json`. */
export interface TemplateSummary {
  id: string;
  name: string;
  description: string;
  family: PlatformFamily;
}

/** Full template metadata read from `templates/<id>/template.json`. */
export interface TemplateMetadata extends TemplateSummary {
  /** Deep-merged into the generated `project.json` after `${...}` substitution. */
  projectJsonExtras?: Record<string, unknown>;
}

/** A materialised file ready to write under the project root. */
export interface TemplateFile {
  /** Path relative to the project root, in POSIX form. */
  path: string;
  content: string;
}

/** Result of `loadTemplate`: metadata + the substituted file tree. */
export interface InstantiatedTemplate {
  metadata: TemplateMetadata;
  files: TemplateFile[];
}

/** Inputs to filename + content substitution. */
export interface TemplateContext {
  /** Replaces `__className__` in filenames. */
  className: string;
  /** Replaces `__packagePath__` in filenames (slash-separated). */
  packagePath: string;
  /** Passed straight into `replace()` for content + projectJsonExtras. */
  replacements: Record<string, unknown>;
}

interface TemplateSource {
  kind: "local" | "remote";
  /** Populated when kind === "local". */
  dir?: string;
  /** Populated when kind === "remote". */
  repo?: string;
  /** Populated when kind === "remote". */
  ref?: string;
}

/**
 * Pick the template source: `PLUGGY_TEMPLATE_DIR` if it points at an existing
 * directory, otherwise the repo identified by `PLUGGY_TEMPLATE_REPO`
 * (`<owner>/<repo>[#<ref>]`), defaulting to this repo on `main`.
 */
function resolveSource(): TemplateSource {
  const localDir = process.env.PLUGGY_TEMPLATE_DIR;
  if (localDir && existsSync(localDir)) {
    return { kind: "local", dir: localDir };
  }
  const remote = process.env.PLUGGY_TEMPLATE_REPO ?? `${DEFAULT_REPO}#${DEFAULT_REF}`;
  const [repo, ref = DEFAULT_REF] = remote.split("#");
  return { kind: "remote", repo, ref };
}

let cachedZip: { key: string; buffer: Buffer } | undefined;

async function fetchRepoZip(repo: string, ref: string): Promise<Buffer> {
  const key = `${repo}#${ref}`;
  if (cachedZip && cachedZip.key === key) return cachedZip.buffer;
  const url = `https://codeload.github.com/${repo}/zip/${ref}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch templates from ${url}: ${res.status} ${res.statusText}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  cachedZip = { key, buffer: buf };
  return buf;
}

/** Fetch the template registry: every entry from `templates/index.json`. */
export async function listTemplates(): Promise<TemplateSummary[]> {
  const source = resolveSource();
  if (source.kind === "local") {
    const text = await readFile(join(source.dir!, "index.json"), "utf8");
    return (JSON.parse(text) as { templates: TemplateSummary[] }).templates;
  }
  const url = `https://raw.githubusercontent.com/${source.repo}/${source.ref}/templates/index.json`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch template index from ${url}: ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as { templates: TemplateSummary[] };
  return data.templates;
}

/**
 * Materialise a template: read its `template.json`, walk its `files/` tree,
 * apply path + content substitution, and merge `${...}` into the
 * `projectJsonExtras` payload. Throws if the template id is unknown.
 */
export async function loadTemplate(
  id: string,
  context: TemplateContext,
): Promise<InstantiatedTemplate> {
  const source = resolveSource();
  if (source.kind === "local") {
    return loadFromLocal(source.dir!, id, context);
  }
  const buffer = await fetchRepoZip(source.repo!, source.ref!);
  return extractFromZip(buffer, id, context);
}

async function loadFromLocal(
  dir: string,
  id: string,
  ctx: TemplateContext,
): Promise<InstantiatedTemplate> {
  const root = join(dir, id);
  if (!existsSync(root)) {
    throw new Error(`Template "${id}" not found at ${root}`);
  }
  const metaText = await readFile(join(root, "template.json"), "utf8");
  const metadata = JSON.parse(metaText) as TemplateMetadata;

  const files: TemplateFile[] = [];
  const filesRoot = join(root, "files");
  if (existsSync(filesRoot)) {
    for (const abs of await walk(filesRoot)) {
      const relPosix = relative(filesRoot, abs).split(sep).join("/");
      const raw = await readFile(abs, "utf8");
      files.push({
        path: applyPathPlaceholders(relPosix, ctx),
        content: replace(raw, ctx.replacements),
      });
    }
  }

  return { metadata: substituteExtras(metadata, ctx), files };
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walk(abs)));
    } else if (entry.isFile()) {
      out.push(abs);
    }
  }
  return out;
}

/**
 * Pull the template subtree out of a GitHub repo zip. The zip's top-level
 * directory is named `<repo>-<ref>/` (where ref may be a branch, tag, or
 * sha); we infer that prefix from the first entry rather than guessing.
 */
function extractFromZip(
  buffer: Buffer,
  id: string,
  ctx: TemplateContext,
): Promise<InstantiatedTemplate> {
  return new Promise((resolveP, rejectP) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) {
        rejectP(err ?? new Error("Failed to open template zip"));
        return;
      }

      const files: TemplateFile[] = [];
      let metadata: TemplateMetadata | undefined;
      let rootPrefix: string | undefined;
      let pending = 0;
      let ended = false;

      const finish = (): void => {
        if (!ended || pending > 0) return;
        zip.close();
        if (!metadata) {
          rejectP(new Error(`Template "${id}" not found in fetched zip`));
          return;
        }
        resolveP({ metadata: substituteExtras(metadata, ctx), files });
      };

      zip.on("entry", (entry: Entry) => {
        if (rootPrefix === undefined) {
          const slash = entry.fileName.indexOf("/");
          rootPrefix = slash >= 0 ? entry.fileName.slice(0, slash + 1) : "";
        }
        const inside =
          rootPrefix.length > 0 ? entry.fileName.slice(rootPrefix.length) : entry.fileName;
        const templateRoot = `templates/${id}/`;
        if (entry.fileName.endsWith("/") || !inside.startsWith(templateRoot)) {
          zip.readEntry();
          return;
        }
        const relInside = inside.slice(templateRoot.length);
        pending += 1;
        readZipEntry(zip, entry)
          .then((bytes) => {
            if (relInside === "template.json") {
              metadata = JSON.parse(bytes.toString("utf8")) as TemplateMetadata;
            } else if (relInside.startsWith("files/")) {
              const rel = relInside.slice("files/".length);
              files.push({
                path: applyPathPlaceholders(rel, ctx),
                content: replace(bytes.toString("utf8"), ctx.replacements),
              });
            }
            pending -= 1;
            zip.readEntry();
            finish();
          })
          .catch((readErr) => {
            pending -= 1;
            rejectP(readErr);
          });
      });
      zip.on("end", () => {
        ended = true;
        finish();
      });
      zip.on("error", rejectP);
      zip.readEntry();
    });
  });
}

function readZipEntry(zip: ZipFile, entry: Entry): Promise<Buffer> {
  return new Promise((resolveP, rejectP) => {
    zip.openReadStream(entry, (err, stream) => {
      if (err || !stream) {
        rejectP(err ?? new Error("no stream"));
        return;
      }
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.once("end", () => resolveP(Buffer.concat(chunks)));
      stream.once("error", rejectP);
    });
  });
}

function applyPathPlaceholders(path: string, ctx: TemplateContext): string {
  return path.replace(/__packagePath__/g, ctx.packagePath).replace(/__className__/g, ctx.className);
}

/**
 * Stringify-replace-parse round-trip on `projectJsonExtras` so JSON values
 * benefit from the same `${...}` substitution as file contents do. Strings
 * that look numeric are kept as strings; `replace()` only touches segments
 * matching `${...}`.
 */
function substituteExtras(metadata: TemplateMetadata, ctx: TemplateContext): TemplateMetadata {
  if (!metadata.projectJsonExtras) return metadata;
  const substituted = replace(JSON.stringify(metadata.projectJsonExtras), ctx.replacements);
  return { ...metadata, projectJsonExtras: JSON.parse(substituted) };
}
