import { createHash } from "node:crypto";
import { access, chmod, constants, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";

import { Command } from "commander";

import { bold, brightBlue, dim, log, red, yellow } from "../logging.ts";

interface GithubReleaseAsset {
  name: string;
  browser_download_url: string;
}

interface GithubRelease {
  tag_name: string;
  html_url: string;
  name: string;
  published_at: string;
  assets?: GithubReleaseAsset[];
}

export interface UpgradeOptions {
  /** GitHub `owner/repo` slug whose releases are queried. */
  repository: string;
  /** Optional GitHub token — only needed for rate-limited CI runs. */
  token?: string;
}

/**
 * Map `process.platform` + `process.arch` to the release asset name used
 * by `.github/workflows/release.yml`. Returns `undefined` when the current
 * platform isn't a published target — the action falls back to printing
 * manual install instructions.
 */
function currentAssetName(): string | undefined {
  const map: Record<string, string> = {
    "darwin-arm64": "pluggy-darwin-arm64",
    "darwin-x64": "pluggy-darwin-amd64",
    "linux-arm64": "pluggy-linux-arm64",
    "linux-x64": "pluggy-linux-amd64",
    "win32-x64": "pluggy-windows-amd64.exe",
  };
  return map[`${process.platform}-${process.arch}`];
}

async function fetchLatestRelease(repository: string, token?: string): Promise<GithubRelease> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `token ${token}`;

  const res = await fetch(`https://api.github.com/repos/${repository}/releases/latest`, {
    headers,
  });
  if (!res.ok) throw new Error(`Failed to fetch latest release: ${res.status} ${res.statusText}`);

  const data = (await res.json()) as GithubRelease & { message?: string };
  if (data.message) throw new Error(`GitHub API error: ${data.message}`);
  return data;
}

function printManualInstructions(repository: string, release: GithubRelease): void {
  log.info(`${bold("Latest release:")} ${brightBlue(release.tag_name)}`);
  log.info(`${bold("Published:")}      ${release.published_at}`);
  log.info(`${bold("URL:")}            ${release.html_url}\n`);
  log.info("Install manually:\n");
  log.info(
    `  ${bold("Unix")}:    curl -fsSL https://github.com/${repository}/releases/latest/download/install.sh | bash`,
  );
  log.info(
    `  ${bold("Windows")}: irm https://github.com/${repository}/releases/latest/download/install.ps1 | iex`,
  );
}

/**
 * Returns true if the current process can replace the file at `path`
 * (i.e., it can write to the containing directory). We probe the
 * directory rather than the file itself because the in-place upgrade
 * works by renaming around the existing binary.
 */
async function canReplaceBinary(path: string): Promise<boolean> {
  try {
    await access(dirname(path), constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** Heuristic: paths a regular user shouldn't be writing to without sudo. */
function isSystemPath(path: string): boolean {
  if (process.platform === "win32") return false;
  return (
    path.startsWith("/usr/") ||
    path.startsWith("/opt/") ||
    path.startsWith("/bin/") ||
    path.startsWith("/sbin/")
  );
}

/**
 * Fetch `SHA256SUMS.txt` for the release and return a map of `assetName ->
 * lowercase hex sha256`. Throws when the manifest is missing — the install
 * pipeline only began publishing the manifest with this version's release
 * workflow, so a missing manifest means we're being asked to upgrade to an
 * unsigned release and `pluggy upgrade` refuses by design.
 *
 * `actions/attest-build-provenance` ships the manifest itself with a
 * Sigstore attestation, so a `gh attestation verify SHA256SUMS.txt --repo
 * <repo>` round-trip catches a tampered manifest at the OIDC-identity
 * level. We don't carry that verifier in-binary yet (it's a follow-up);
 * the manifest hash check below catches simple asset-only substitution.
 */
async function fetchExpectedSha256(
  repository: string,
  tag: string,
  assetName: string,
): Promise<string> {
  const manifestUrl = `https://github.com/${repository}/releases/download/${tag}/SHA256SUMS.txt`;
  const res = await fetch(manifestUrl);
  if (!res.ok) {
    throw new Error(
      `failed to fetch ${manifestUrl}: ${res.status} ${res.statusText}. ` +
        `This release does not publish a checksum manifest; refusing to upgrade to an unverified binary. ` +
        `Re-install manually if you trust this release: ` +
        `curl -fsSL https://github.com/${repository}/releases/download/${tag}/install.sh | bash`,
    );
  }
  const text = await res.text();
  const expected = parseShaManifest(text, assetName);
  if (expected === undefined) {
    throw new Error(
      `SHA256SUMS.txt at ${manifestUrl} has no entry for "${assetName}". Refusing to upgrade.`,
    );
  }
  return expected;
}

/** Parse `<sha256-hex>  <filename>` lines, return the hex matching `name` (or undefined). */
function parseShaManifest(text: string, name: string): string | undefined {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0) continue;
    // sha256sum format: "<hex><space><space><filename>" — but tolerate one or
    // more spaces / tabs to match other generators.
    const match = line.match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/);
    if (match === null) continue;
    if (match[2].trim() === name) return match[1].toLowerCase();
  }
  return undefined;
}

/**
 * Download the release asset for the current platform into a temp file,
 * verify it against `SHA256SUMS.txt`, rename the running binary out of the
 * way (Windows tolerates this; Unix is routine), and move the new binary
 * into its place. On failure, the old binary is restored from the `.old`
 * backup so the user isn't left with a broken install.
 */
async function replaceInPlace(
  downloadUrl: string,
  currentBinaryPath: string,
  expectedSha256: string,
  assetName: string,
  repository: string,
): Promise<{ backupPath: string }> {
  const binaryRes = await fetch(downloadUrl);
  if (!binaryRes.ok) {
    throw new Error(
      `failed to download ${downloadUrl}: ${binaryRes.status} ${binaryRes.statusText}`,
    );
  }
  const bytes = new Uint8Array(await binaryRes.arrayBuffer());
  if (bytes.length === 0) {
    throw new Error(`downloaded asset from ${downloadUrl} is empty`);
  }

  const actualSha = createHash("sha256").update(bytes).digest("hex");
  if (actualSha !== expectedSha256) {
    throw new Error(
      `integrity check failed for ${assetName} — SHA256SUMS.txt expects ${expectedSha256} but downloaded bytes hash to ${actualSha}. ` +
        `Refusing to install a tampered binary; please report at https://github.com/${repository}/issues.`,
    );
  }

  const tempDir = await mkdtemp(join(tmpdir(), "pluggy-upgrade-"));
  const stagedPath = join(tempDir, "pluggy-new");
  await writeFile(stagedPath, bytes);
  if (process.platform !== "win32") {
    await chmod(stagedPath, 0o755);
  }

  const backupPath = `${currentBinaryPath}.old`;
  await rm(backupPath, { force: true });

  await rename(currentBinaryPath, backupPath);
  try {
    await rename(stagedPath, currentBinaryPath);
  } catch (err) {
    // Best-effort restore so the user isn't left without a working binary.
    await rename(backupPath, currentBinaryPath).catch(() => {});
    throw new Error(
      `failed to install new binary at ${currentBinaryPath}; restored previous version: ${(err as Error).message}`,
    );
  }

  await rm(tempDir, { recursive: true, force: true });
  return { backupPath };
}

function printPermissionGuidance(repository: string, currentBinaryPath: string): void {
  log.error(
    `cannot write to ${currentBinaryPath} — pluggy was installed to a system path and upgrades from there require root.`,
  );
  log.info("");
  log.info(`${bold("Recommended:")} reinstall pluggy to your home directory (no sudo):`);
  log.info("");
  log.info(
    `  ${dim("$")} curl -fsSL https://github.com/${repository}/releases/latest/download/install.sh | bash`,
  );
  log.info("");
  log.info(`Then remove the old system binary so it doesn't shadow the new one:`);
  log.info("");
  log.info(`  ${dim("$")} sudo rm ${currentBinaryPath}`);
  log.info("");
  log.info(`${bold("Or:")} re-run the upgrade with elevated privileges:`);
  log.info("");
  log.info(`  ${dim("$")} sudo pluggy upgrade`);
}

/**
 * Factory for the `pluggy upgrade` commander command.
 *
 * Default behaviour: fetch the latest GitHub release, download the asset
 * for the running platform, and atomically replace the current binary.
 * `--print-only` skips the replacement and prints manual instructions —
 * same behaviour we had before in-place upgrade was wired up.
 */
export function upgradeCommand(options: UpgradeOptions): Command {
  return new Command("upgrade")
    .description("Upgrade pluggy to the latest version.")
    .option(
      "--print-only",
      "Don't download; just print the latest release info and install commands.",
    )
    .action(async function action(this: Command, cmdOptions) {
      const release = await fetchLatestRelease(options.repository, options.token);

      if (cmdOptions.printOnly === true) {
        printManualInstructions(options.repository, release);
        return;
      }

      const assetName = currentAssetName();
      if (assetName === undefined) {
        log.warn(
          `${yellow("!")} No release asset available for ${process.platform}/${process.arch}; printing install instructions instead.`,
        );
        printManualInstructions(options.repository, release);
        return;
      }

      const currentBinaryPath = process.execPath;

      if (!(await canReplaceBinary(currentBinaryPath))) {
        if (isSystemPath(currentBinaryPath)) {
          printPermissionGuidance(options.repository, currentBinaryPath);
        } else {
          log.error(
            `cannot write to ${dirname(currentBinaryPath)}. Check the directory's permissions and retry.`,
          );
        }
        const err = new Error("upgrade aborted: install location is not writable") as Error & {
          exitCode?: number;
        };
        err.exitCode = 1;
        throw err;
      }

      const downloadUrl = `https://github.com/${options.repository}/releases/download/${release.tag_name}/${assetName}`;

      log.info(`${bold("Upgrading to:")} ${brightBlue(release.tag_name)}`);
      log.info(`${dim(`downloading ${downloadUrl}`)}`);

      try {
        const expectedSha = await fetchExpectedSha256(
          options.repository,
          release.tag_name,
          assetName,
        );
        const { backupPath } = await replaceInPlace(
          downloadUrl,
          currentBinaryPath,
          expectedSha,
          assetName,
          options.repository,
        );
        log.success(
          `pluggy ${release.tag_name} installed at ${currentBinaryPath} (previous binary backed up to ${backupPath})`,
        );
      } catch (err) {
        log.error(`${red("✖")} ${(err as Error).message}`);
        printManualInstructions(options.repository, release);
        throw err;
      }
    });
}
