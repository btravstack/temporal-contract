# Examples

> Complete working examples demonstrating temporal-contract

## Available Examples

### [order-processing-contract](./order-processing-contract)

Shared contract package — domain schemas and the workflow/activity definitions imported by both the worker and the client

### [order-processing-worker](./order-processing-worker)

Worker with Clean Architecture; activities return `AsyncResult` from unthrown

### [order-processing-client](./order-processing-client)

Standalone client demonstrating interaction with the shared contract

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
