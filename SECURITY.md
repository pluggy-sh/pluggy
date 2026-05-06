# Security policy

Report security vulnerabilities privately. Do not open public issues for security bugs, because unfixed reports expose other users.

## Reporting a vulnerability

File a report through GitHub's [private vulnerability reporting](https://github.com/ch99q/pluggy/security/advisories/new). If you cannot use GitHub, email `64793a1a@gmail.com` with the same content.

Include in the report:

- The version (`pluggy -V`) and the platform you reproduced on.
- A minimal reproduction: commands, project layout, and any inputs.
- The impact you observed and the impact you believe is possible.
- Any suggested fix or mitigation.

You will receive an acknowledgement within 72 hours. We aim to confirm or reject the report within 7 days, and to ship a fix or mitigation within 30 days for confirmed issues. If a fix takes longer, we will explain why and agree on a timeline with you.

## Supported versions

Only the latest released version receives security fixes. pluggy is pre-1.0 and ships from `main`.

## Scope

The pluggy CLI, the install scripts (`install.sh`, `install.ps1`), and code under `src/` and `templates/` are in scope.

The following are out of scope because pluggy does not control them:

- Vulnerabilities in third-party plugins, server JARs (Paper, Spigot, Velocity), or JDK distributions that pluggy downloads.
- Vulnerabilities in upstream registries (Modrinth, Maven Central, Foojay Disco) or in the artifacts they host.
- Issues that require an attacker who already controls the user's machine or development environment.

If you are unsure whether something is in scope, report it anyway and we will route it.

## Disclosure

We coordinate disclosure with the reporter. Once a fix is released, we publish a GitHub Security Advisory crediting the reporter unless they request anonymity.
