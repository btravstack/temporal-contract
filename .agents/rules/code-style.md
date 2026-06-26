# Code Style

## TypeScript Rules

- **No `any`** — always use `unknown` (enforced by oxlint).
- **No `interface`** — use `type` (enforced by oxlint `consistent-type-definitions`). One allowed exception: module augmentation / declaration merging requires `interface` (see `packages/testing/src/global-setup.ts:6` augmenting vitest's `ProvidedContext`). Disable the rule inline with a comment.
- **Use `.js` extensions** in all imports (even for `.ts` files) — required by ESM module resolution.
- **Prefer `type` imports** (`import type { ... }`) where possible — not currently lint-enforced, so use judgement.
- All packages extend `@temporal-contract/tsconfig/base.json` (strict mode).

### Strict-mode quirks worth knowing

The shared tsconfig at `tools/tsconfig/base.json` enables three non-default flags that surprise people:

| Flag                                 | What it does                                                                                                         |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `noUncheckedIndexedAccess`           | `obj[key]` returns `T \| undefined` even when typed as `Record<string, T>`. Narrow with `if (value)` or `??`.        |
| `exactOptionalPropertyTypes`         | `{ cause?: Error }` does NOT accept `{ cause: undefined }`. To omit the field, omit the key entirely (use a spread). |
| `noPropertyAccessFromIndexSignature` | Index-signature lookups must use `obj["key"]`, not `obj.key`. Forces explicit-shape vs dynamic-key intent.           |

Idiomatic spread for optional `cause` (visible in `handlers.md` and across the codebase):

```typescript
ApplicationFailure.create({
  type: "X",
  message: "...",
  ...(error instanceof Error ? { cause: error } : {}), // omit, don't pass undefined
});
```

`oxlint` enforces only two rules (`@typescript-eslint/no-explicit-any`, `typescript/consistent-type-definitions`) — see `.oxlintrc.json`. The rest of oxlint's defaults are off.

## Error Handling

- Use unthrown's `Result<T, E>` / `AsyncResult<T, E>` instead of throwing exceptions
- Activities return `AsyncResult<T, ApplicationFailure>`
- Client methods return `AsyncResult<T, E>` with specific error types
- Narrow results before reaching `.value` / `.error` / `.cause` — both the `r.isOk()` method and the `isOk(r)` free function are type guards (same for `isErr` / `isDefect`); the codebase uses the methods
- An unanticipated throw surfaces on unthrown's third **`defect`** channel, not as a typed `err`; build error classes with `TaggedError("Name")<{ ...payload }>`
- Wrap technical exceptions in `ApplicationFailure` (re-exported from `@temporal-contract/worker/activity`) with a `type` field; set `nonRetryable: true` for permanent failures

## Module System

- ESM only (`"type": "module"` in package.json)
- Use `workspace:*` protocol for internal dependencies
- Build with `tsdown`

## Formatting

- **oxfmt** for formatting, import sorting, and package.json ordering
- Run `pnpm format` to fix, `pnpm format --check` to verify

## Anti-patterns

- No deep barrel files — a single `src/index.ts` per package entry point is fine,
  but don't add intermediate `index.ts` files inside subfolders. Within a package,
  always import from specific modules (`./builder.js`, not `.`).
- No default exports in library code
- **Library packages don't log.** `contract`, `client`, and `worker` are silent — let the consumer wire their own observability. The `examples/` workers/clients use `pino` for their own demo logging. `testing` is the documented exception: `packages/testing/src/global-setup.ts` uses `console.log`/`console.error` to surface testcontainers progress, which belongs to the test runner, not the application.
- No mutation of shared state
