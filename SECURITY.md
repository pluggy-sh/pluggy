# Security policy

Report security vulnerabilities privately. Do not open public issues for security bugs, because unfixed reports expose other users.

## Reporting a vulnerability

File a report through GitHub's [private vulnerability reporting](https://github.com/pluggy-sh/pluggy/security/advisories/new). If you cannot use GitHub, email `64793a1a@gmail.com` with the same content.

Include in the report:

- The version (`pluggy -V`) and the platform you reproduced on.
- A minimal reproduction: commands, project layout, and any inputs.
- The impact you observed and the impact you believe is possible.
- Any suggested fix or mitigation.

You will receive an acknowledgement within 72 hours. We aim to confirm or reject the report within 7 days, and to ship a fix or mitigation within 30 days for confirmed issues. If a fix takes longer, we will explain why and agree on a timeline with you.

## Supported versions

Only the latest released version receives security fixes. pluggy is pre-1.0 and ships from `main`. The upgrade path is `pluggy upgrade`, which verifies the new binary against the published `SHA256SUMS.txt` and a Sigstore-issued build-provenance attestation before swapping it in place.

## Threat model

`pluggy` is a developer-facing CLI invoked from a terminal in a trusted local environment. Its threat model assumes:

- The user trusts the terminal they invoke `pluggy` from and the project directory they invoke it inside. Cloning a hostile repository and running `pluggy build` against it is **not** a supported safe operation — the same way `npm install` against a hostile package isn't.
- `process.env`, CLI flags, and `~/.config/pluggy/*` are inputs from the user, not an attacker. An attacker who can modify these on the user's machine has already won.
- HTTPS is the trust root for every external download (GitHub Releases, Foojay Disco, Modrinth, Maven repositories, JetBrains CDN, HotswapProjects, SpigotMC). We additionally verify integrity at the artifact level wherever upstream publishes a hash.

In scope, and what the codebase actively defends against:

- **Supply-chain substitution** of any artifact `pluggy` downloads — JDKs, BuildTools, JBR, HotswapAgent, Modrinth/Maven dependencies, the `pluggy` binary itself. Verification is layered: registry-published hashes (Disco, Modrinth API, Maven `.sha1`/`.sha512`), pinned hashes for upstreams that don't publish sidecars (JBR, HotswapAgent), TOFU pinning where neither is available (BuildTools.jar), and `SHA256SUMS.txt` + Sigstore build-provenance attestations on `pluggy upgrade`.
- **Lockfile integrity** — `pluggy.lock`'s `integrity` is verified at install time (cache and re-resolve) and at build time (lockfile-driven `expectedIntegrity` threading through every resolver). Silent rolls forward across pinned versions are rejected.
- **Zip/path-traversal** in any archive `pluggy` extracts — template archives from `codeload.github.com`, dependency jars during shading, JDK and JBR tarballs/zips. Every archive entry is run through a `safeJoin` that rejects `..`, absolute paths, and backslash-bearing names.
- **Cache-path traversal** via hostile `pluggy.lock` or `project.json` content. Components used to compute filesystem paths (`distribution`, `slug`, `groupId`, `artifactId`, `resolvedVersion`, `integrity` hex) are checked against a tight allowlist before being joined.

## Scope

The pluggy CLI, the install scripts (`install.sh`, `install.ps1`), and code under `src/` and `templates/` are in scope.

The following are out of scope because pluggy does not control them:

- Vulnerabilities in third-party plugins, server JARs (Paper, Spigot, Velocity), or JDK distributions that pluggy downloads.
- Vulnerabilities in upstream registries (Modrinth, Maven Central, Foojay Disco) or in the artifacts they host.
- Issues that require an attacker who already controls the user's machine or development environment.
- Compromise of the `pluggy` GitHub release pipeline itself. Each release is attested with `actions/attest-build-provenance` so the binary is bound to a specific workflow's OIDC identity, but if the pipeline is subverted (leaked publishing credentials, malicious workflow change merged via PR), the attestation will validate for the substituted bytes too. Reducing this requires Sigstore signature verification rooted outside `api.github.com`, which is tracked as future work.

If you are unsure whether something is in scope, report it anyway and we will route it.

## Disclosure

We coordinate disclosure with the reporter. Once a fix is released, we publish a GitHub Security Advisory crediting the reporter unless they request anonymity.
