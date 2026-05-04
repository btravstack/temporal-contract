# Code Style

## TypeScript Rules

- **No `any`** — always use `unknown` (enforced by oxlint)
- **No `interface`** — use `type` instead (enforced by oxlint `consistent-type-definitions`)
- **Use `.js` extensions** in all imports (even for `.ts` files)
- **Use `type` imports** where possible (`import type { ... }`)
- All packages extend `@temporal-contract/tsconfig/base.json` (strict mode)

## Error Handling

- Use neverthrow's `Result<T, E>` / `ResultAsync<T, E>` instead of throwing exceptions
- Activities return `ResultAsync<T, ApplicationFailure>`
- Client methods return `ResultAsync<T, E>` with specific error types
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
- No `console.log` — use structured logging (pino)
- No mutation of shared state
