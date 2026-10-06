# Examples

> Complete working examples demonstrating temporal-contract

## Available Examples

### [order-processing-contract](./order-processing-contract)

Shared contract package — domain schemas plus the workflow, activity, signal, query, and typed-error definitions imported by both the worker and the client (composition-first with the `define*` helpers)

### [order-processing-worker](./order-processing-worker)

Worker with Clean Architecture; activities return `AsyncResult` from unthrown, the workflow handles signals/queries via `context.handleSignal`/`handleQuery`, and a schedule-driven cleanup workflow shows the activity-less workflow shape

### [order-processing-client](./order-processing-client)

Standalone client demonstrating the connection-scoped `TypedClient.create({ client })` / contract-bound `.for(contract)` split: typed signals (with and without payload), an argument-less query, a typed `PaymentDeclined` contract error matched with `P.tag`, and a recurring schedule with the create-if-absent idiom

**Note**: The client example works with the worker implementation seamlessly through the shared contract (`orderProcessingContract`).

## Running Examples

Run every command from the repository root:

```bash
# Terminal 1 — start a local Temporal server
temporal server start-dev

# Install and build the packages the examples consume
pnpm install && pnpm build

# Terminal 2 — run the worker
pnpm --filter @temporal-contract/sample-order-processing-worker dev

# Terminal 3 — run the client
pnpm --filter @temporal-contract/sample-order-processing-client dev
```

## Documentation

**[Read the full documentation](https://btravstack.github.io/temporal-contract)**

- [Examples Overview](https://btravstack.github.io/temporal-contract/examples/)
- [Your first workflow](https://btravstack.github.io/temporal-contract/tutorial/your-first-workflow)
- [API Reference](https://btravstack.github.io/temporal-contract/api/)

## License

MIT
