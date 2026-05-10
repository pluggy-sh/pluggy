import { createHash, X509Certificate } from "node:crypto";
import { access, chmod, constants, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Buffer } from "node:buffer";
import { dirname, join } from "node:path";
import process from "node:process";

import { Command } from "commander";

import {
  type InstallInfo,
  describeInstallMethod,
  detectInstallMethod,
  upgradeCommandFor,
} from "../install-method.ts";
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
  /** Optional GitHub token; only needed for rate-limited CI runs. */
  token?: string;
}

/**
 * Map `process.platform` + `process.arch` to the release asset name used
 * by `.github/workflows/release.yml`. Returns `undefined` when the current
 * platform isn't a published target. The action falls back to printing
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
 * lowercase hex sha256`. Throws when the manifest is missing. The install
 * pipeline only began publishing the manifest with this version's release
 * workflow, so a missing manifest means we're being asked to upgrade to an
 * unsigned release and `pluggy upgrade` refuses by design.
 *
 * The manifest itself isn't trust-rooted: an attacker substituting both
 * the binary and the manifest URL still wins this layer. The downstream
 * attestation check (`assertAttestedByWorkflow`) closes that gap by
 * binding the binary's sha256 to a Sigstore certificate issued for this
 * repo's release workflow.
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
    // sha256sum format: "<hex><space><space><filename>"; tolerate one or
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
      `integrity check failed for ${assetName}: SHA256SUMS.txt expects ${expectedSha256} but downloaded bytes hash to ${actualSha}. ` +
        `Refusing to install a tampered binary; please report at https://github.com/${repository}/issues.`,
    );
  }

  await assertAttestedByWorkflow(repository, actualSha, assetName);

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

/**
 * Cross-check the downloaded asset's sha256 against GitHub's attestation
 * store. `actions/attest-build-provenance` records a Sigstore attestation
 * for every release artifact; the GitHub API exposes those at
 * `/repos/{owner}/{repo}/attestations/sha256:{hex}`. We require:
 *
 *   1. At least one attestation exists for the binary's sha256 in this
 *      repo's attestation store.
 *   2. The attestation's leaf certificate's SAN identifies the issuing
 *      OIDC identity as this repo's `.github/workflows/*.yml` workflow.
 *
 * (1) means an attacker who substitutes only the asset URL fails: they
 * can't generate an attestation for arbitrary bytes without GitHub's
 * Fulcio-issued cert. (2) hardens against an attacker substituting both
 * the asset and an attestation from an unrelated repo: the cert's
 * subject-alternative-name is bound to the OIDC identity that requested
 * it, so a different workflow's attestation has a different SAN.
 *
 * We deliberately don't verify the Sigstore signature in-binary: that
 * would mean shipping a Fulcio trust root and a full bundle verifier, a
 * substantial amount of crypto code. The check above trusts GitHub's
 * attestation API as a transport (same channel as the asset download),
 * which is a meaningful improvement over no attestation at all without
 * the implementation cost of a complete client-side Sigstore verifier.
 */
async function assertAttestedByWorkflow(
  repository: string,
  sha256Hex: string,
  assetName: string,
): Promise<void> {
  const url = `https://api.github.com/repos/${repository}/attestations/sha256:${sha256Hex}`;
  const res = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) {
    throw new Error(
      `failed to verify attestation for ${assetName}: GitHub API returned ${res.status} ${res.statusText} for ${url}. ` +
        `Refusing to install a binary with no recorded build provenance.`,
    );
  }
  const data = (await res.json()) as { attestations?: { bundle?: unknown }[] };
  const attestations = Array.isArray(data.attestations) ? data.attestations : [];
  if (attestations.length === 0) {
    throw new Error(
      `no build-provenance attestation found for ${assetName} in ${repository}. ` +
        `Refusing to install: every release after this version must be attested by the release workflow. ` +
        `If this is unexpected, report at https://github.com/${repository}/issues.`,
    );
  }

  const expectedIdentityPrefix = `https://github.com/${repository}/.github/workflows/`;
  const errors: string[] = [];
  for (const att of attestations) {
    const bundle = att.bundle;
    if (bundle === null || typeof bundle !== "object") continue;
    const certPem = extractLeafCertificatePem(bundle as Record<string, unknown>);
    if (certPem === undefined) {
      errors.push("attestation bundle had no leaf certificate");
      continue;
    }
    let cert: X509Certificate;
    try {
      cert = new X509Certificate(certPem);
    } catch (err) {
      errors.push(`certificate parse failed: ${(err as Error).message}`);
      continue;
    }
    const san = cert.subjectAltName ?? "";
    if (san.includes(expectedIdentityPrefix)) {
      log.debug(`upgrade: attestation OK for ${assetName} (SAN matches ${expectedIdentityPrefix})`);
      return;
    }
    errors.push(
      `attestation SAN ${JSON.stringify(san.slice(0, 200))} does not include ${expectedIdentityPrefix}`,
    );
  }
  throw new Error(
    `attestation identity mismatch for ${assetName}: none of the ${attestations.length} attestation(s) were issued for ${expectedIdentityPrefix}*. ` +
      `Refusing to install. Details: ${errors.join("; ")}`,
  );
}

/**
 * Pull the leaf certificate (PEM-encoded) out of a Sigstore bundle. Handles
 * both the legacy `x509CertificateChain.certificates[0]` and modern
 * `certificate` shapes that GitHub's attestation API returns. The cert's
 * raw bytes are base64-encoded DER; we re-wrap as PEM for X509Certificate.
 */
function extractLeafCertificatePem(bundle: Record<string, unknown>): string | undefined {
  const vm = bundle.verificationMaterial;
  if (vm === null || typeof vm !== "object") return undefined;
  const material = vm as Record<string, unknown>;

  let rawBytesB64: string | undefined;

  const direct = material.certificate as { rawBytes?: unknown } | undefined;
  if (direct !== undefined && typeof direct.rawBytes === "string") {
    rawBytesB64 = direct.rawBytes;
  }

  if (rawBytesB64 === undefined) {
    const chain = material.x509CertificateChain as
      | { certificates?: { rawBytes?: unknown }[] }
      | undefined;
    const first = chain?.certificates?.[0];
    if (first !== undefined && typeof first.rawBytes === "string") {
      rawBytesB64 = first.rawBytes;
    }
  }

  if (rawBytesB64 === undefined) return undefined;

  // base64 → DER → PEM-wrapped, which is what X509Certificate accepts.
  const der = Buffer.from(rawBytesB64, "base64");
  const b64 = der.toString("base64");
  const wrapped = b64.replace(/(.{64})/g, "$1\n");
  return `-----BEGIN CERTIFICATE-----\n${wrapped}\n-----END CERTIFICATE-----\n`;
}

function printManagedInstallGuidance(install: InstallInfo, upgradeCmd: string): void {
  const label = describeInstallMethod(install.method);
  log.error(
    `${red("✖")} pluggy was installed via ${label}. ${bold("Don't")} self-update; that would corrupt the package manager's tracking.`,
  );
  log.info("");
  log.info(`${bold("Run this instead:")}`);
  log.info("");
  log.info(`  ${dim("$")} ${upgradeCmd}`);
  log.info("");
  log.info(
    `${dim(`(detected install path: ${install.resolvedPath}. Override with --force if you really mean it.)`)}`,
  );
}

function printPermissionGuidance(repository: string, currentBinaryPath: string): void {
  log.error(
    `cannot write to ${currentBinaryPath}: pluggy was installed to a system path and upgrades from there require root.`,
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
 * `--print-only` skips the replacement and prints manual instructions:
 * same behaviour we had before in-place upgrade was wired up.
 */
export function upgradeCommand(options: UpgradeOptions): Command {
  return new Command("upgrade")
    .description("Upgrade pluggy to the latest version.")
    .option(
      "--print-only",
      "Don't download; just print the latest release info and install commands.",
    )
    .option(
      "--force",
      "Self-update even when pluggy was installed via a package manager. Not recommended; use the package manager's upgrade command instead.",
    )
    .action(async function action(this: Command, cmdOptions) {
      const release = await fetchLatestRelease(options.repository, options.token);

      if (cmdOptions.printOnly === true) {
        printManualInstructions(options.repository, release);
        return;
      }

      const installInfo = detectInstallMethod();
      const managedUpgrade = upgradeCommandFor(installInfo.method);
      if (managedUpgrade !== undefined && cmdOptions.force !== true) {
        printManagedInstallGuidance(installInfo, managedUpgrade);
        const err = new Error(
          `upgrade aborted: pluggy was installed via ${describeInstallMethod(installInfo.method)}; run \`${managedUpgrade}\` instead`,
        ) as Error & { exitCode?: number };
        err.exitCode = 1;
        throw err;
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
