# Order Processing Worker

> Type-safe order processing worker with Clean Architecture and unthrown's AsyncResult pattern

## Running

```bash
# Prerequisites: Temporal server running and packages built
temporal server start-dev

# Run from this directory
pnpm dev
```

## What It Demonstrates

- ✅ Type-safe contracts with Zod
- ✅ Activities returning `AsyncResult` (never throwing) — technical faults
  wrapped via `qualifyFailure(...)`, domain declines produced with the typed
  `errors.PaymentDeclined(...)` constructor from the helpers argument
- ✅ Signal and query handlers registered inside the workflow via
  `context.defineSignal` / `context.defineQuery` (deterministic, replay-safe
  state), including a payload-less signal and an argument-less query
- ✅ An approval gate built on `condition(...)` — orders above $100 wait for
  the `approveOrder` signal (or `cancelRequested` / a timeout)
- ✅ A typed contract error rethrown end-to-end: activity → workflow
  (`context.errors.PaymentDeclined`) → typed client
- ✅ An activity-less, schedule-driven workflow (`cleanupExpiredOrders`) that
  needs no entry in the activities implementation map
- ✅ Clean Architecture (Domain → Infrastructure → Application)
- ✅ Dependency injection for testability
- ✅ Error handling with compensating actions

## Documentation

📖 **[Read the full documentation →](https://btravstack.github.io/temporal-contract)**

- [Examples overview](https://btravstack.github.io/temporal-contract/examples/)
- [Your first workflow](https://btravstack.github.io/temporal-contract/tutorial/your-first-workflow)

## License

MIT
