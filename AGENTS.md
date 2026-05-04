# Agent Instructions

> **temporal-contract** — Type-safe contract system for Temporal.io workflows and activities

This file is the source of truth for agent guidance in this repo. `CLAUDE.md` and `.github/copilot-instructions.md` are symlinks to it.

## The 6 rules that prevent broken PRs

1. **Workflow code is deterministic.** No `Date.now()`, `Math.random()`, `setTimeout`, `crypto.randomUUID()`, native I/O, or `process.env` reads inside `declareWorkflow`'s `implementation`. Use `@temporalio/workflow` primitives (`sleep`, `uuid4`, the patched `Date`) or push the side effect into an activity. See [.agents/rules/workflow-determinism.md](.agents/rules/workflow-determinism.md). This is the #1 cause of broken Temporal workflows — read that file before touching workflow code.
2. **Activities and the typed client return `ResultAsync<T, E>` from `neverthrow`.** Never throw — wrap technical errors in `ApplicationFailure` and surface them via `errAsync(...)` (or `.mapErr(...)` on a `ResultAsync.fromPromise(...)` chain). The client uses neverthrow's `Result` for sync returns. There is no `@swan-io/boxed` and no `@temporal-contract/boxed` package — those were removed.
3. **No `any`.** Use `unknown` and narrow. Enforced by oxlint.
4. **`.js` extensions in every import.** TypeScript files import each other as `./foo.js`, never `./foo` or `./foo.ts`. Required by ESM module resolution.
5. **ESM only.** All packages are `"type": "module"`. No CommonJS in source.
6. **Catalog versions.** Edit `pnpm-workspace.yaml`'s `catalog:` block to bump a dependency, never per-package `package.json` versions. Anything that appears in a published package's public types must be a peer dep, not a regular dep — see `dependencies.md`.

## Rule reference

| Rule                                                                 | File                                                                           |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Project overview                                                     | [.agents/rules/project-overview.md](.agents/rules/project-overview.md)         |
| Commands, releases, commits                                          | [.agents/rules/commands.md](.agents/rules/commands.md)                         |
| Contract patterns                                                    | [.agents/rules/contract-patterns.md](.agents/rules/contract-patterns.md)       |
| Handlers (activities, workflows, cancellation, `ApplicationFailure`) | [.agents/rules/handlers.md](.agents/rules/handlers.md)                         |
| **Workflow determinism**                                             | [.agents/rules/workflow-determinism.md](.agents/rules/workflow-determinism.md) |
| Code style + strict-mode quirks                                      | [.agents/rules/code-style.md](.agents/rules/code-style.md)                     |
| Testing                                                              | [.agents/rules/testing.md](.agents/rules/testing.md)                           |
| Dependencies + peer-dep policy                                       | [.agents/rules/dependencies.md](.agents/rules/dependencies.md)                 |
| Adding a new package                                                 | [.agents/rules/adding-a-package.md](.agents/rules/adding-a-package.md)         |
