<div align="center">

# temporal-contract

**Type-safe contracts for Temporal.io**

End-to-end type safety and automatic validation for workflows and activities

[![CI](https://github.com/btravstack/temporal-contract/actions/workflows/ci.yml/badge.svg)](https://github.com/btravstack/temporal-contract/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@temporal-contract/contract.svg?logo=npm)](https://www.npmjs.com/package/@temporal-contract/contract)
[![npm downloads](https://img.shields.io/npm/dm/@temporal-contract/contract.svg)](https://www.npmjs.com/package/@temporal-contract/contract)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.0-blue?logo=typescript)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

[**Documentation**](https://btravstack.github.io/temporal-contract) · [**Get Started**](https://btravstack.github.io/temporal-contract/guide/getting-started) · [**Examples**](https://btravstack.github.io/temporal-contract/examples/)

</div>

## Features

- ✅ **End-to-end type safety** — From contract to client, workflows, and activities
- ✅ **Automatic validation** — Zod schemas validate at all network boundaries
- ✅ **Compile-time checks** — TypeScript catches missing or incorrect implementations
- ✅ **Better DX** — Autocomplete, refactoring support, inline documentation
- ✅ **Child workflows** — Type-safe child workflow execution with unthrown's `AsyncResult`
- ✅ **Result pattern** — Explicit error handling without exceptions, powered by [unthrown](https://github.com/btravstack/unthrown)
- 🚧 **Nexus support** — Cross-namespace operations (planned for v0.5.0)

## Quick Example

```typescript
// Define contract once
const contract = defineContract({
  taskQueue: "orders",
  workflows: {
    processOrder: {
      input: z.object({ orderId: z.string() }),
      output: z.object({ success: z.boolean() }),
      activities: {
        processPayment: {
          input: z.object({ orderId: z.string() }),
          output: z.object({ transactionId: z.string() }),
        },
      },
    },
  },
});

// Implement activities with unthrown's AsyncResult
import { declareActivitiesHandler, ApplicationFailure } from "@temporal-contract/worker/activity";
import { fromPromise } from "unthrown";

const activities = declareActivitiesHandler({
  contract,
  activities: {
    processPayment: ({ orderId }) =>
      fromPromise(paymentService.process(orderId), (error) =>
        ApplicationFailure.create({
          type: "PAYMENT_FAILED",
          message: error instanceof Error ? error.message : "Payment failed",
          ...(error instanceof Error ? { cause: error } : {}),
        }),
      ).map((txId) => ({ transactionId: txId })),
  },
});

// Call from client - fully typed everywhere
const result = await client.executeWorkflow("processOrder", {
  workflowId: "order-123",
  args: { orderId: "ORD-123" }, // ✅ TypeScript knows!
});
```

## Installation

```bash
# Core packages
pnpm add @temporal-contract/contract @temporal-contract/worker @temporal-contract/client

# Result/AsyncResult — peer dep used by worker/client APIs
pnpm add unthrown
```

## Documentation

📖 **[Read the full documentation →](https://btravstack.github.io/temporal-contract)**

- [Getting Started](https://btravstack.github.io/temporal-contract/guide/getting-started)
- [Core Concepts](https://btravstack.github.io/temporal-contract/guide/core-concepts)
- [API Reference](https://btravstack.github.io/temporal-contract/api/)
- [Examples](https://btravstack.github.io/temporal-contract/examples/)

## Packages

| Package                                            | Description                                |
| -------------------------------------------------- | ------------------------------------------ |
| [@temporal-contract/contract](./packages/contract) | Contract builder and type definitions      |
| [@temporal-contract/worker](./packages/worker)     | Type-safe worker with automatic validation |
| [@temporal-contract/client](./packages/client)     | Type-safe client for consuming workflows   |
| [@temporal-contract/testing](./packages/testing)   | Testing utilities for integration tests    |

## Usage Patterns

temporal-contract uses **[unthrown](https://github.com/btravstack/unthrown)** end-to-end (workflows, activities, and the typed client) for explicit error handling via `Result` and `AsyncResult`, with a separate `defect` channel for unanticipated failures. Migrating from a previous release that used `neverthrow`? See [Migrating to unthrown](https://btravstack.github.io/temporal-contract/guide/migrating-to-unthrown).

## Contributing

See [CONTRIBUTING.md](https://github.com/btravstack/temporal-contract/blob/main/CONTRIBUTING.md).

## License

MIT
