# Examples

> Complete working examples demonstrating temporal-contract

## Available Examples

### [order-processing-contract](./order-processing-contract)

Shared contract package — domain schemas plus the workflow, activity, signal, query, and typed-error definitions imported by both the worker and the client (composition-first with the `define*` helpers)

### [order-processing-worker](./order-processing-worker)

Worker with Clean Architecture; activities return `AsyncResult` from unthrown, the workflow handles signals/queries via `context.handleSignal`/`handleQuery`, and a schedule-driven cleanup workflow shows the activity-less workflow shape

### [order-processing-client](./order-processing-client)

Standalone client demonstrating the `TypedClient.create({ client }).for(contract)` split: typed signals (with and without payload), an argument-less query, a typed `PaymentDeclined` contract error matched with `P.tag`, and a recurring schedule with the create-if-absent idiom

**Note**: The client example works with the worker implementation seamlessly through the shared contract (`orderProcessingContract`).

## Running Examples

```bash
# Start Temporal server
temporal server start-dev

# Install and build from repository root
cd ../..
pnpm install && pnpm build

# Run the worker
cd examples/order-processing-worker
pnpm dev  # Terminal 1

# Run the client (in another terminal)
cd examples/order-processing-client
pnpm dev  # Terminal 2
```

## Documentation

**[Read the full documentation](https://btravstack.github.io/temporal-contract)**

- [Examples Overview](https://btravstack.github.io/temporal-contract/examples/)
- [Your first workflow](https://btravstack.github.io/temporal-contract/tutorial/your-first-workflow)
- [API Reference](https://btravstack.github.io/temporal-contract/api/)

## License

MIT
