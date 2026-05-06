# Contributing to Pluggy

Thank you for your interest in contributing to Pluggy! This document provides guidelines for contributing to this project.

By participating, you agree to abide by the [Code of Conduct](CODE_OF_CONDUCT.md). To report a security vulnerability, follow the [Security Policy](SECURITY.md) instead of opening a public issue.

## Development Setup

### Prerequisites

- [Bun](https://bun.sh/) 1.3 or later (for producing the single-file binary via `bun build --compile`)
- [Vite+](https://vite.plus/) (`vp`) for the day-to-day dev loop — install, check, lint, format, test
- Git
- A text editor or IDE
- JDK 21+ on the `PATH` (required by tests that hit BuildTools and by `pluggy dev`)

### Getting Started

1. Fork the repository
2. Clone your fork locally:
   ```bash
   git clone https://github.com/your-username/pluggy.git
   cd pluggy
   ```
3. Create a new branch for your feature or bugfix:
   ```bash
   git checkout -b feature/your-feature-name
   ```

### Development Workflow

1. Install dependencies:

   ```bash
   vp install
   ```

2. Make your changes
3. Run the checks Vite+ bundles (format, lint, type-check) and the test suite:

   ```bash
   vp check
   vp test
   ```

4. Build and smoke-test the single-file binary:

   ```bash
   bun build --compile --outfile=bin/pluggy ./src/index.ts
   ./bin/pluggy --help
   ```

## Code Style

- Use TypeScript with strict type checking
- Run `vp fmt` (Oxfmt) before committing; CI enforces it via `vp check`
- Use meaningful variable and function names
- Add JSDoc comments for public APIs
- Keep functions focused and reasonably sized
- Follow the design guidance in `conventions/QUALITY.md` and `conventions/PERFORMANCE.md`

## Testing

- Test all new functionality manually
- Ensure existing functionality still works
- Test on different platforms when possible
- Document any breaking changes

## Submitting Changes

1. Commit your changes with a clear commit message:
   ```bash
   git commit -m "feat: add support for custom repositories"
   ```
2. Push to your fork:
   ```bash
   git push origin feature/your-feature-name
   ```
3. Create a Pull Request with:
   - Clear description of the changes
   - Any relevant issue numbers
   - Screenshots for UI changes (if applicable)

## Commit Message Format

Use conventional commit format:

- `feat:` for new features
- `fix:` for bug fixes
- `docs:` for documentation changes
- `refactor:` for code refactoring
- `test:` for test additions
- `chore:` for maintenance tasks

## Reporting Issues

When reporting issues, please include:

- Operating system and version
- `pluggy -V` output (the CLI version) and the Bun version used to build it, if self-built
- Steps to reproduce
- Expected vs actual behavior
- Any error messages

## Feature Requests

Feature requests are welcome! Please:

- Check if the feature already exists
- Describe the use case clearly
- Explain why it would be valuable
- Consider if it fits the project's scope

## Questions?

Feel free to open an issue for questions or discussion about contributing.

Thank you for helping make Pluggy better!
