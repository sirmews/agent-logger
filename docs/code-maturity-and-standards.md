# Code Maturity and Standards

This document outlines the engineering standards and quality gates for the `agent-logger` project.

## Quality Gates

The `bun run quality` command is the authoritative gate for CI/CD and Pull Requests. It includes:

1.  **Type Checking:** `tsc --noEmit` ensures full TypeScript compliance.
2.  **Unit Tests:** `bun test` runs all tests in the `tests/` directory, including integration and evaluation tests.
3.  **Linting (ESLint):** Enforces JSDoc requirements for all public/exported symbols.
4.  **AST Analysis (ast-grep):** Enforces reliability and security policies.

## AST-Grep Rules

The project uses `ast-grep` to enforce advanced rules that standard linters might miss:

-   **Reliability:**
    -   `no-floating-promises`: Ensures all asynchronous operations are properly handled, preventing silent database write failures.
-   **Security:**
    -   `no-hardcoded-secrets`: Scans the codebase for high-entropy strings or known secret patterns.
-   **Maintainability:**
    -   `warn-large-functions`: Flags functions exceeding 100 lines to encourage decomposition and readability.

## JSDoc Requirements

All exported functions, classes, and types must include JSDoc comments. This ensures the plugin's internal API remains navigable for contributors.

```typescript
/**
 * Resolves the database path from environment variables.
 * @param env - The process environment.
 * @returns The absolute path to the SQLite database.
 */
export function resolveDbPath(env: NodeJS.ProcessEnv = process.env): string { ... }
```

## Semantic Versioning (SemVer)

The project strictly follows [Semantic Versioning 2.0.0](https://semver.org/).

### Version Increments

- **MAJOR (x.0.0):** Incremented for incompatible API changes.
  - Database schema changes that require manual intervention or break old tool consumers.
  - Significant changes to tool output structures (e.g., `export_training_data` format change).
  - Removing or renaming supported environment variables.
- **MINOR (0.x.0):** Incremented for new, backwards-compatible functionality.
  - Adding new tools or hooks.
  - Adding new optional environment variables.
  - Significant internal improvements (e.g., batching logic).
- **PATCH (0.0.x):** Incremented for backwards-compatible bug fixes.
  - Fixing edge-case database leaks (like the `session_diffs` prune fix).
  - Improving documentation or test coverage.

### Schema Versioning vs Package Versioning

The `SCHEMA_VERSION` in `src/index.ts` tracks the SQLite schema state.
- Every increment of `SCHEMA_VERSION` **MUST** be accompanied by at least a **MINOR** version bump in `package.json`.
- If the schema change is non-additive (e.g., dropping a column), it **MUST** be a **MAJOR** version bump.

## Pull Request Expectations

Before submitting a PR, ensure:
- [ ] `bun run quality` passes without errors.
- [ ] The version in `package.json` has been appropriately bumped if functionality or schema changed.
- [ ] Any new feature includes corresponding integration tests in `tests/`.
- [ ] Schema changes are accompanied by a version bump in \`src/index.ts\` and documentation updates.
- [ ] Large functions are refactored into smaller, testable units.

## Release Workflow

To ensure consistent versioning and documentation, use the following commands for releases:

### 1. Standard Release (Automatic)
This will run the quality gate, bump the version based on commit history, update `CHANGELOG.md`, and create a git tag.
```bash
bun run release
```

### 2. Forced Version Release
If you need to force a specific version increment:
```bash
bun run release:patch
bun run release:minor
bun run release:major
```

### 3. Publishing to NPM
The `prepublishOnly` hook automatically runs the `scripts/pre-publish.ts` safety check. This ensures you are on `main`, your working directory is clean, and all tests pass.
```bash
npm publish
```
