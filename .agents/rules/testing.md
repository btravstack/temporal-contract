# Testing

## Framework

- **Vitest** with `describe`/`it`/`expect` patterns
- Coverage via `@vitest/coverage-v8`

## File Conventions

| Type              | Location                  | Pattern                   |
| ----------------- | ------------------------- | ------------------------- |
| Unit tests        | `src/*.spec.ts`           | Alongside source files    |
| Integration tests | `src/__tests__/*.spec.ts` | In `__tests__/` directory |

## Vitest Configuration

Each package with tests has a `vitest.config.ts` using projects. Canonical example: `packages/worker/vitest.config.ts:11-27`.

```typescript
projects: [
  {
    test: { name: "unit", include: ["src/**/*.spec.ts"], exclude: ["src/**/__tests__/*.spec.ts"] },
  },
  {
    test: {
      name: "integration",
      globalSetup: "@temporal-contract/testing/global-setup",
      include: ["src/**/__tests__/*.spec.ts"],
      testTimeout: 10_000,
    },
  },
];
```

Packages without integration tests omit the `integration` project — see `packages/contract/vitest.config.ts` for the unit-only template.

## Integration Tests

- Require Docker (Temporal server + Postgres via testcontainers — see `packages/testing/src/global-setup.ts`)
- Use `@temporal-contract/testing` for global setup
- Run with `pnpm test:integration`
- `turbo.json` marks `test` and `test:integration` with `"cache": false` — they always re-run

## Running Tests

```bash
pnpm test                                  # All unit tests
pnpm test:integration                      # All integration tests (needs Docker)
pnpm --filter @temporal-contract/worker test  # Single package
pnpm --filter @temporal-contract/worker test -- --coverage  # Pass flags to vitest
```
