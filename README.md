<div align="center">

# temporal-contract

**Type-safe contracts for Temporal.io**

End-to-end type safety and automatic validation for workflows and activities

[![CI](https://github.com/btravers/temporal-contract/actions/workflows/ci.yml/badge.svg)](https://github.com/btravers/temporal-contract/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@temporal-contract/contract.svg?logo=npm)](https://www.npmjs.com/package/@temporal-contract/contract)
[![npm downloads](https://img.shields.io/npm/dm/@temporal-contract/contract.svg)](https://www.npmjs.com/package/@temporal-contract/contract)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.0-blue?logo=typescript)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

[**Documentation**](https://btravers.github.io/temporal-contract) · [**Get Started**](https://btravers.github.io/temporal-contract/guide/getting-started) · [**Examples**](https://btravers.github.io/temporal-contract/examples/)

</div>

## Features

- ✅ **End-to-end type safety** — From contract to client, workflows, and activities
- ✅ **Automatic validation** — Zod schemas validate at all network boundaries
- ✅ **Compile-time checks** — TypeScript catches missing or incorrect implementations
- ✅ **Better DX** — Autocomplete, refactoring support, inline documentation
- ✅ **Child workflows** — Type-safe child workflow execution with Result/Future pattern
- ✅ **Result/Future pattern** — Explicit error handling without exceptions
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

// Implement activities with Future/Result pattern
import { declareActivitiesHandler, ActivityError } from "@temporal-contract/worker/activity";
import { Future } from "@swan-io/boxed";

const activities = declareActivitiesHandler({
  contract,
  activities: {
    processPayment: ({ orderId }) => {
      return Future.fromPromise(paymentService.process(orderId))
        .mapError((error) => new ActivityError("PAYMENT_FAILED", "Payment failed", error))
        .mapOk((txId) => ({ transactionId: txId }));
    },
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

# Result/Future pattern (already included in worker/client via @swan-io/boxed)
pnpm add @swan-io/boxed
```

## Documentation

📖 **[Read the full documentation →](https://btravers.github.io/temporal-contract)**

- [Getting Started](https://btravers.github.io/temporal-contract/guide/getting-started)
- [Core Concepts](https://btravers.github.io/temporal-contract/guide/core-concepts)
- [API Reference](https://btravers.github.io/temporal-contract/api/)
- [Examples](https://btravers.github.io/temporal-contract/examples/)

## Packages

| Package                                            | Description                                                                     |
| -------------------------------------------------- | ------------------------------------------------------------------------------- |
| [@temporal-contract/contract](./packages/contract) | Contract builder and type definitions                                           |
| [@temporal-contract/worker](./packages/worker)     | Type-safe worker with automatic validation (uses @swan-io/boxed for activities) |
| [@temporal-contract/client](./packages/client)     | Type-safe client for consuming workflows (uses @swan-io/boxed)                  |
| [@temporal-contract/boxed](./packages/boxed)       | Temporal-compatible Result/Future types for workflows (alternative to @swan-io) |
| [@temporal-contract/testing](./packages/testing)   | Testing utilities for integration tests                                         |

## Usage Patterns

temporal-contract uses **[@swan-io/boxed](https://github.com/swan-io/boxed)** for activities and clients, providing excellent error handling with Result/Future patterns. For workflows that require Temporal's deterministic execution, use **@temporal-contract/boxed** which provides a compatible API.

## Contributing

See [CONTRIBUTING.md](https://github.com/btravers/temporal-contract/blob/main/CONTRIBUTING.md).

## License

MIT
