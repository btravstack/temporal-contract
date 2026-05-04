# Agent Instructions

> **temporal-contract** — Type-safe contract system for Temporal.io workflows and activities

This file is the source of truth for agent guidance in this repo. `CLAUDE.md` is a symlink to it (Claude Code looks for either).

## The 5 rules that prevent broken PRs

1. **Activities and the typed client return `ResultAsync<T, E>` from `neverthrow`.** Never throw — wrap technical errors in `ApplicationFailure` and surface them via `errAsync(...)` (or `.mapErr(...)` on a `ResultAsync.fromPromise(...)` chain). The client uses neverthrow's `Result` for sync returns. There is no `@swan-io/boxed` and no `@temporal-contract/boxed` package — those were removed.
2. **No `any`.** Use `unknown` and narrow. Enforced by oxlint.
3. **`.js` extensions in every import.** TypeScript files import each other as `./foo.js`, never `./foo` or `./foo.ts`. Required by ESM module resolution.
4. **ESM only.** All packages are `"type": "module"`. No CommonJS in source.
5. **Catalog versions.** Edit `pnpm-workspace.yaml`'s `catalog:` block to bump a dependency, never per-package `package.json` versions. Anything that appears in a published package's public types must be a peer dep, not a regular dep — see `dependencies.md`.

## Rule reference

| Rule              | File                                                                     |
| ----------------- | ------------------------------------------------------------------------ |
| Project overview  | [.agents/rules/project-overview.md](.agents/rules/project-overview.md)   |
| Commands          | [.agents/rules/commands.md](.agents/rules/commands.md)                   |
| Contract patterns | [.agents/rules/contract-patterns.md](.agents/rules/contract-patterns.md) |
| Handlers          | [.agents/rules/handlers.md](.agents/rules/handlers.md)                   |
| Code style        | [.agents/rules/code-style.md](.agents/rules/code-style.md)               |
| Testing           | [.agents/rules/testing.md](.agents/rules/testing.md)                     |
| Dependencies      | [.agents/rules/dependencies.md](.agents/rules/dependencies.md)           |
