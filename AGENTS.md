# Agent Instructions

> **temporal-contract** — Type-safe contract system for Temporal.io workflows and activities

This file is the source of truth for agent guidance in this repo. `CLAUDE.md` and `.github/copilot-instructions.md` are symlinks to it.

## The 6 rules that prevent broken PRs

1. **Workflow code is deterministic — and the sandbox enforces most of it for you.** `Date.now()`, `new Date()`, `Math.random()`, and `setTimeout` are **patched** in the sandbox and are replay-safe; `WeakRef`/`FinalizationRegistry` throw `DeterminismViolationError`; `crypto.*`, `fetch`, and native I/O aren't in the sandbox context at all. Prefer `@temporalio/workflow`'s `sleep` / `uuid4` / `workflowInfo()` anyway, because the patched APIs don't mean what their names suggest (`Date.now()` is _workflow_ time; `setTimeout` is a _durable timer_). The genuinely unprotected hazards inside `declareWorkflow`'s `implementation` are **`process.env` reads, module-level mutable state, and `import.meta`** — spend your vigilance there. See [.agents/rules/workflow-determinism.md](.agents/rules/workflow-determinism.md) before touching workflow code.
2. **Activities and the typed client return `AsyncResult<T, E>` from `unthrown`.** Never throw — wrap technical errors in `ApplicationFailure` and surface them via `ErrAsync(...)` (or `fromPromise(promise, qualify)`, where `qualify` returns the modeled error `E`). `OkAsync(value)`/`ErrAsync(error)` are the canonical pre-lifted constructors (there is no lowercase `okAsync`/`errAsync`); lifting an existing sync `Result` with `.toAsync()` stays valid but is not used for direct construction in this codebase — prefer `OkAsync()` zero-arg over `OkAsync(undefined)`. The client uses unthrown's `Result` for sync returns. unthrown adds a third **`defect`** channel for _unanticipated_ failures — a thrown exception the code didn't model surfaces as a defect (inspectable via `result.isDefect()` / `result.cause`, re-thrown at the edge), not a typed `err`. Narrow before reaching `.value`/`.error`/`.cause` — both the `r.isOk()` method and the `isOk(r)` free function are type guards (same for `isErr`/`isDefect`); the codebase uses the methods. Error classes are built with `TaggedError("@temporal-contract/Name", { name: "Name" })<{ ...payload }>` — the `_tag` is package-namespaced to avoid collisions, while `options.name` keeps `Error.name` the bare class name for readable logs. The worker's `ValidationError` subclasses are the exception — they must stay `ApplicationFailure` for Temporal's terminal-failure semantics. There is no `neverthrow`, no `@swan-io/boxed`, and no `@temporal-contract/boxed` package — those were removed.
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
