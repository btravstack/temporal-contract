# Contributing to temporal-contract

Thanks for your interest! This file is a quick on-ramp; the agent rules in [`.agents/rules/`](./.agents/rules/) are the canonical source for conventions.

## Prerequisites

- **Node.js** 24+
- **pnpm** 10+
- **Docker** (for integration tests)

## Quick start

```bash
git clone https://github.com/btravers/temporal-contract.git
cd temporal-contract
pnpm install
pnpm build
pnpm test
```

## Development workflow

1. Create a branch from `main`.
2. Make your changes. **Workflow code must be deterministic** — see [`.agents/rules/workflow-determinism.md`](./.agents/rules/workflow-determinism.md).
3. Run quality checks (`pnpm typecheck && pnpm lint && pnpm format --check && pnpm test && pnpm knip`).
4. Create a changeset: `pnpm changeset`.
5. Submit a pull request.

Pre-commit hooks (Lefthook) run formatting + linting; commit-msg hooks validate Conventional Commits.

## Where to look

| Topic                                                     | File                                                                               |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Project architecture                                      | [`.agents/rules/project-overview.md`](./.agents/rules/project-overview.md)         |
| Commands, release flow, commit types                      | [`.agents/rules/commands.md`](./.agents/rules/commands.md)                         |
| Defining a contract                                       | [`.agents/rules/contract-patterns.md`](./.agents/rules/contract-patterns.md)       |
| Activities, workflows, cancellation, `ApplicationFailure` | [`.agents/rules/handlers.md`](./.agents/rules/handlers.md)                         |
| **Workflow determinism** (READ FIRST)                     | [`.agents/rules/workflow-determinism.md`](./.agents/rules/workflow-determinism.md) |
| Code style + strict-mode quirks                           | [`.agents/rules/code-style.md`](./.agents/rules/code-style.md)                     |
| Test conventions                                          | [`.agents/rules/testing.md`](./.agents/rules/testing.md)                           |
| Dependencies + peer-dep policy                            | [`.agents/rules/dependencies.md`](./.agents/rules/dependencies.md)                 |
| Adding a new package                                      | [`.agents/rules/adding-a-package.md`](./.agents/rules/adding-a-package.md)         |
