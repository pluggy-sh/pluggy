## Commit Message Conventions

This repository follows the Conventional Commits specification for commit messages. This means that each commit message should be structured in the following format:

```<type>[optional scope]: <description>
[optional body]
[optional footer(s)]
```

Where:

- `<type>` is a required field that indicates the type of change being made. Common types include `feat` for new features, `fix` for bug fixes, `docs` for documentation changes, `style` for code formatting, `refactor` for code changes that neither fix a bug nor add a feature, and `test` for adding or modifying tests.
- `[optional scope]` is an optional field that provides additional context about the change, such as the area of the codebase affected (e.g., `api`, `ui`, `database`).
- `<description>` is a required field that provides a brief summary of the change.
- `[optional body]` is an optional field that can include a more detailed description of the change, including the motivation for the change and any relevant background information.
- `[optional footer(s)]` is an optional field that can include any additional information, such as breaking changes or issues closed by the commit.

Examples of valid commit messages:

```feat(api): add new endpoint for user authentication
fix(ui): resolve issue with button alignment
docs: update README with installation instructions
style: reformat code using Prettier
refactor: simplify data fetching logic
test: add unit tests for user model
```

By following these conventions, we can maintain a clear and consistent commit history that makes it easier to understand the changes being made and the reasons behind them. This also helps with generating changelogs and automating releases based on commit messages.

Please do not co-author commits with AI assistants, as this can create confusion about the source of the changes and may not accurately reflect the contributions of human developers. Instead, focus on writing clear and descriptive commit messages that accurately convey the intent and impact of the changes being made.

## Conventions

See `conventions/` for the full conventions with examples in both TypeScript and Go:

- **`conventions/QUALITY.md`** -API design: verb+noun entry points, category objects, single call backbone, no global state, fail-early errors.
- **`conventions/PERFORMANCE.md`** -Performance: data structure selection, bounded collections, early exits, signal over polling, hot-path allocations, batching, coordination.

## Runtime & tooling

Vite+ (`vp`) drives the development loop. Bun produces the shipped CLI binary. See the Vite+ block below for the full command surface.

- `vp install` - install dependencies
- `vp check` - format, lint, and type checks (Oxlint + Oxfmt + tsgo)
- `vp test` - run tests via the bundled Vitest
- `vp dev` / `vp pack` - library build during development
- `bun build --compile --outfile=bin/pluggy ./src/index.ts` - standalone CLI binary for releases

Vite+'s `pack` only emits JavaScript. The single-file executable is always produced with Bun's `--compile` flag, which is what ships to users via the install scripts.

### Testing

Use `vite-plus/test` (the Vitest wrapper). Do **not** install `vitest` directly.

```ts
import { expect, test } from "vite-plus/test";
import { getPlatform } from "../src/platform/index.ts";

test("spigot platform is registered", () => {
  expect(getPlatform("spigot").id).toBe("spigot");
});
```

Tests live next to the code they cover as `*.test.ts`. Network-dependent tests (platform `download`, `getVersions`) hit real upstream APIs intentionally — do not mock them.

### Manual testing & the `playground/` folder

`playground/` at the repo root is gitignored and exists for ad-hoc manual testing of the CLI — building the binary with `bun build --compile --outfile=bin/pluggy ./src/index.ts`, then running `pluggy init`, `pluggy build`, `pluggy dev`, etc. against a scratch project to verify the actual user experience. Use it whenever a change has a UX surface that the test suite can't cover (interactive prompts, error formatting, generated `project.json` shape, BuildTools output, dev server startup). Create subdirectories per scenario (`playground/spigot-1.21/`, `playground/cross-family/`, …) and feel free to leave them around — nothing in `playground/` is committed.

### Filing issues for bugs you stumble across

When you spot a bug that isn't in scope for the current task — typically while exercising the CLI in `playground/` or while reviewing unrelated code — log it as a GitHub issue so it doesn't get forgotten. The workflow:

1. Search first: `gh issue list --search "<keywords>" --state all`. Try a couple of phrasings (the symptom, the affected command, the affected file) before assuming it's new.
2. If no match, surface it to the human: describe the bug, the reproduction, and a draft body, then ask whether to file. Don't open issues unprompted.
3. On approval, file with `gh issue create --title "…" --label bug --body "…"`. Match the bug-report template's sections (Summary / Reproduction / Expected / Actual / pluggy version / `pluggy doctor` output / Additional context) — `gh issue create` doesn't auto-apply YAML form templates, so reproduce the structure in the body. Templates live in `.github/ISSUE_TEMPLATE/`.
4. For a bug found while finishing a PR, link the issue from the PR description so the connection is visible without searching.

### CLI conventions

- Every command lives in `src/commands/<name>.ts` and exports a factory `xxxCommand()` that returns a `Command` (from `commander`). `src/index.ts` imports the factories and calls `program.addCommand()` — keep `index.ts` thin.
- Inside an action, read global flags with `this.optsWithGlobals()` (the action must be a non-arrow `function` so `this` binds). Never reference a module-level `currentProject` — resolve fresh inside the action.
- Every command must honour the global `--json` flag: emit a single structured JSON object on success, and a `{ status: "error", message, exitCode }` object on failure. Never mix JSON and human text in the same output.
- Throw `InvalidArgumentError` (from `commander`) for user-input problems; throw regular `Error` for runtime/IO failures. Both are caught by the top-level handler in `src/index.ts`, which formats them per `--json`.
- Use `@inquirer/prompts` for interactive prompts. `--yes` or `--json` must bypass prompts entirely — with `--json`, prompts become errors rather than hangs.
- New platform providers go through `createPlatform((ctx) => ({ ... }))` and must be imported from `src/platform/index.ts` for the side-effect registration. `createPlatform` must not perform I/O at module-load time — defer disk writes to the command that needs them (otherwise the Bun-compiled binary crashes reading from the read-only `$bunfs` path).

### Stub-module convention

Many modules are stubs: their functions throw `new Error("not implemented: <name>")`. When implementing a stub:

1. Write or un-skip the contract tests in `<module>.test.ts` first. They're `describe.skip` blocks with concrete assertions — they define the contract the implementation must satisfy.
2. Replace the `throw` body with the implementation.
3. Remove the `.skip` from the tests and confirm they pass with `vp test <module>`.
4. Do not change exported function signatures, argument shapes, or return types without checking every caller in the repo — these are the contract other modules rely on.

This pattern lets parallel agents implement different modules without blocking on each other.

### Cross-platform requirements

Every file path, process spawn, signal, and UI concern must work identically on macOS, Linux, and Windows:

- Paths in `project.json` / `pluggy.lock` are always forward-slashed (normalize via `portable.toPosixPath`).
- Link large files with `portable.linkOrCopy` (hardlink first, copy fallback — never symlink).
- Signal handling goes through `portable.installShutdownHandler` which wraps `child.kill()` (the cross-platform Node shim).
- Write generated files with LF line endings (`portable.writeFileLF`).
- Never spawn a shell — always call `spawn(cmd, args, ...)` directly. Node handles `.exe` on Windows.

<!--VITE PLUS START-->

# Using Vite+, the Unified Toolchain for the Web

This project is using Vite+, a unified toolchain built on top of Vite, Rolldown, Vitest, tsdown, Oxlint, Oxfmt, and Vite Task. Vite+ wraps runtime management, package management, and frontend tooling in a single global CLI called `vp`. Vite+ is distinct from Vite, but it invokes Vite through `vp dev` and `vp build`.

## Vite+ Workflow

`vp` is a global binary that handles the full development lifecycle. Run `vp help` to print a list of commands and `vp <command> --help` for information about a specific command.

### Start

- create - Create a new project from a template
- migrate - Migrate an existing project to Vite+
- config - Configure hooks and agent integration
- staged - Run linters on staged files
- install (`i`) - Install dependencies
- env - Manage Node.js versions

### Develop

- dev - Run the development server
- check - Run format, lint, and TypeScript type checks
- lint - Lint code
- fmt - Format code
- test - Run tests

### Execute

- run - Run monorepo tasks
- exec - Execute a command from local `node_modules/.bin`
- dlx - Execute a package binary without installing it as a dependency
- cache - Manage the task cache

### Build

- build - Build for production
- pack - Build libraries
- preview - Preview production build

### Manage Dependencies

Vite+ automatically detects and wraps the underlying package manager such as pnpm, npm, or Yarn through the `packageManager` field in `package.json` or package manager-specific lockfiles.

- add - Add packages to dependencies
- remove (`rm`, `un`, `uninstall`) - Remove packages from dependencies
- update (`up`) - Update packages to latest versions
- dedupe - Deduplicate dependencies
- outdated - Check for outdated packages
- list (`ls`) - List installed packages
- why (`explain`) - Show why a package is installed
- info (`view`, `show`) - View package information from the registry
- link (`ln`) / unlink - Manage local package links
- pm - Forward a command to the package manager

### Maintain

- upgrade - Update `vp` itself to the latest version

These commands map to their corresponding tools. For example, `vp dev --port 3000` runs Vite's dev server and works the same as Vite. `vp test` runs JavaScript tests through the bundled Vitest. The version of all tools can be checked using `vp --version`. This is useful when researching documentation, features, and bugs.

## Common Pitfalls

- **Using the package manager directly:** Do not use pnpm, npm, or Yarn directly. Vite+ can handle all package manager operations. For Bun-specific operations that Vite+ does not wrap (notably `bun build --compile`), calling `bun` directly is expected.
- **Always use Vite commands to run tools:** Don't attempt to run `vp vitest` or `vp oxlint`. They do not exist. Use `vp test` and `vp lint` instead.
- **Running scripts:** Vite+ built-in commands (`vp dev`, `vp build`, `vp test`, etc.) always run the Vite+ built-in tool, not any `package.json` script of the same name. To run a custom script that shares a name with a built-in command, use `vp run <script>`.
- **Do not install Vitest, Oxlint, Oxfmt, or tsdown directly:** Vite+ wraps these tools. They must not be installed directly. You cannot upgrade these tools by installing their latest versions. Always use Vite+ commands.
- **Use Vite+ wrappers for one-off binaries:** Use `vp dlx` instead of package-manager-specific `dlx`/`npx` commands.
- **Import JavaScript modules from `vite-plus`:** Instead of importing from `vite` or `vitest`, all modules should be imported from the project's `vite-plus` dependency. For example, `import { defineConfig } from 'vite-plus';` or `import { expect, test, vi } from 'vite-plus/test';`. You must not install `vitest` to import test utilities.
- **Type-Aware Linting:** There is no need to install `oxlint-tsgolint`, `vp lint --type-aware` works out of the box.

## CI Integration

For GitHub Actions, consider using [`voidzero-dev/setup-vp`](https://github.com/voidzero-dev/setup-vp) to replace separate `actions/setup-node`, package-manager setup, cache, and install steps with a single action.

```yaml
- uses: voidzero-dev/setup-vp@v1
  with:
    cache: true
- run: vp check
- run: vp test
```

## Review Checklist for Agents

- [ ] Run `vp install` after pulling remote changes and before getting started.
- [ ] Run `vp check` and `vp test` to validate changes.
- [ ] For release-shaped changes, verify `bun build --compile --outfile=bin/pluggy ./src/index.ts` still produces a working binary.
<!--VITE PLUS END-->
