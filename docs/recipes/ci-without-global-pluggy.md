# CI builds without pluggy installed globally

CI runners usually don't have pluggy installed. You have three options: use the [`pluggy-sh/setup-pluggy`](https://github.com/pluggy-sh/setup-pluggy) GitHub Action (simplest on GitHub), install via the standalone script (works on any CI), or check the binary into your CI image (fastest).

## Option 1: `pluggy-sh/setup-pluggy` GitHub Action (recommended on GitHub Actions)

The action installs pluggy, adds it to `PATH`, and restores the pluggy data-directory cache between runs.

```yaml
# .github/workflows/build.yml
name: Build

on:
  push:
    branches: [main]
  pull_request:

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Set up JDK 21
        uses: actions/setup-java@v4
        with:
          distribution: temurin
          java-version: 21

      - name: Install pluggy
        uses: pluggy-sh/setup-pluggy@v1

      - name: Check project health
        run: pluggy doctor

      - name: Build
        run: pluggy build --json

      - uses: actions/upload-artifact@v4
        with:
          name: plugin-jar
          path: bin/*.jar
```

Pin an exact pluggy version for reproducible builds:

```yaml
- uses: pluggy-sh/setup-pluggy@v1
  with:
    pluggy-version: '0.2.3'
```

The action's full input and output surface (cache toggling, cache key prefix, `pluggy-version` and `pluggy-path` outputs) is documented in the [setup-pluggy README](https://github.com/pluggy-sh/setup-pluggy#readme). It works on `ubuntu-*`, `macos-*`, and `windows-*` runners without per-OS workarounds.

## Option 2: Install per job with the standalone script

Use this on CIs other than GitHub Actions, or when you want to avoid an action dependency. pluggy's install script is standalone. On POSIX runners:

```yaml
# .github/workflows/build.yml
name: Build

on:
  push:
    branches: [main]
  pull_request:

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Set up JDK 21
        uses: actions/setup-java@v4
        with:
          distribution: temurin
          java-version: 21

      - name: Install pluggy
        run: |
          curl -fsSL https://pluggy.sh/install.sh | sh

      - name: Cache pluggy downloads
        uses: actions/cache@v4
        with:
          path: ~/.cache/pluggy
          key: pluggy-${{ runner.os }}-${{ hashFiles('pluggy.lock') }}
          restore-keys: pluggy-${{ runner.os }}-

      - name: Check project health
        run: pluggy doctor

      - name: Build
        run: pluggy build --json

      - uses: actions/upload-artifact@v4
        with:
          name: plugin-jar
          path: bin/*.jar
```

Notes:

- The install script drops the binary in `~/.pluggy/bin/`, no `sudo` required.
- Caching `~/.cache/pluggy` speeds up subsequent runs by skipping dependency downloads. Key it on `pluggy.lock` so cache hits are reproducible.
- `pluggy doctor` catches config drift in a PR before the build attempts it and fails with a longer error.
- `pluggy build --json` emits one envelope per workspace. A failed build exits `1` without terminating the step from an unrelated error.

## Option 3: Pin a specific pluggy version

The install script always fetches `latest`. For reproducible builds, pin
a tag:

```bash
VERSION=v0.2.0
mkdir -p ~/.pluggy/bin
curl -fsSL "https://github.com/pluggy-sh/pluggy/releases/download/${VERSION}/pluggy-linux-amd64" -o ~/.pluggy/bin/pluggy
chmod +x ~/.pluggy/bin/pluggy
echo "$HOME/.pluggy/bin" >> $GITHUB_PATH
```

Bump `VERSION` when you want to move to a newer pluggy.

## Option 4: Check the binary into a container image

For self-hosted runners or when you're already building a custom
container:

```dockerfile
FROM eclipse-temurin:21-jdk
RUN curl -fsSL https://github.com/pluggy-sh/pluggy/releases/latest/download/pluggy-linux-amd64 \
    -o /usr/local/bin/pluggy \
 && chmod +x /usr/local/bin/pluggy
```

For ARM runners, swap `-linux-amd64` for `-linux-arm64`.

## Windows runners

`pluggy-sh/setup-pluggy@v1` already handles `PATH` on `windows-*` runners. If you skip the action and call the PowerShell install script directly, the binary lands in your user `PATH`, which doesn't propagate to the same job step. Either fully qualify the path or add the directory to `$env:PATH` explicitly:

```yaml
- name: Install pluggy
  shell: pwsh
  run: |
    irm https://pluggy.sh/install.ps1 | iex
    # Add to PATH for the rest of this job
    echo "$env:LOCALAPPDATA\Programs\pluggy" >> $env:GITHUB_PATH
```

## JSON output in CI

`--json` is the preferred mode for CI. Every command emits a JSON envelope on stdout (success) or stderr (failure), and exits with `0` for success or non-zero for failure. Use `jq` to pull specific fields:

```bash
pluggy build --json | jq -r '.results[0].outputPath'
```

On failure the envelope has shape:

```json
{ "status": "error", "message": "...", "exitCode": 1 }
```

For `build`, partial failures in a multi-workspace project produce:

```json
{
  "status": "error",
  "results": [
    { "workspace": "api", "ok": true, "outputPath": "...", "sizeBytes": 42123, "durationMs": 1802 },
    { "workspace": "impl", "ok": false, "durationMs": 120, "error": "..." }
  ]
}
```

## Reproducible builds

- Check `pluggy.lock` into git. Lock drift breaks reproducibility. The lockfile locks concrete versions and integrity hashes.
- Pin `compatibility.versions[0]` to a specific Minecraft version. Don't let `init` pick "latest" and then forget to pin it.
- Use `pluggy install` without `--force` on CI. `--force` re-resolves from upstream even when the lockfile is fresh, which defeats the caching.

## Caching effectively

pluggy's cache is split into stable and drift-y parts:

| Path                            | Stable?                                                                    |
| ------------------------------- | -------------------------------------------------------------------------- |
| `~/.cache/pluggy/dependencies/` | Very stable. Content-addressed. Cache with gusto.                          |
| `~/.cache/pluggy/versions/`     | Platform jars, one per (platform, version, build). Stable once downloaded. |
| `~/.cache/pluggy/BuildTools/`   | Spigot and Bukkit build output. Expensive to regenerate.                   |

A single cache entry keyed on `pluggy.lock` covers dependencies. Add a fallback restore key (`pluggy-${{ runner.os }}-`) so a lockfile bump still benefits from partial cache hits.

## See also

- [`pluggy doctor`](../commands/doctor.md): pre-build validation.
- [`pluggy build`](../commands/build.md): JSON output shape.
- [`pluggy cache`](../commands/cache.md): inspect and prune the cache from CI.
- [Cross-platform notes](../cross-platform.md): cache paths per OS.
