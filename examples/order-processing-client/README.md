# Order Processing Client Sample

> Standalone client sample demonstrating how to interact with the unified order processing contract

This sample demonstrates that a single client can interact with any worker implementation of the unified contract.

## Overview

This client package demonstrates:

- The `TypedClient.create({ client })` (connection-scoped root) +
  `.for(contract)` (contract-scoped client) split
- Typed signals through the workflow handle — `approveOrder` with a validated
  payload, and the payload-less `cancelRequested` sent with no arguments
- An argument-less query (`getOrderStatus`) reading live workflow state
- The synchronous `getHandle`, returning a `Result` whose only Err is
  `WorkflowNotInContractError`
- A typed contract error (`PaymentDeclined`) rehydrated from a failed
  execution and matched exhaustively with unthrown's `match` + `P.tag`
- A recurring cleanup schedule via `schedule.create(...)`, with the
  `ScheduleAlreadyExistsError` branch implementing the create-if-absent idiom

## Running the Sample

### Prerequisites

1. Start Temporal server:

```bash
temporal server start-dev
```

2. Build the workspace from the repository root:

```bash
cd ../..
pnpm install && pnpm build
```

### Running

1. Start the worker:

```bash
cd ../order-processing-worker
pnpm dev
```

2. Run the client:

```bash
cd ../order-processing-client
pnpm dev
```

## Testing

Integration tests live in the worker package
(`../order-processing-worker/src/integration.spec.ts`) and cover the same
surface this client demonstrates — start/execute, the approval signal + status
query, the payload-less cancellation signal, input validation, and the typed
`PaymentDeclined` contract error:

```bash
cd ../order-processing-worker
pnpm test:integration # requires Docker (testcontainers)
```

## What to Notice

- **Same Contract**: The client uses `orderProcessingContract` from `@temporal-contract/sample-order-processing-contract`
- **Same Task Queue**: All workers listen on the same task queue: `"order-processing"`
- **Worker Agnostic**: The client doesn't know or care which worker implementation is running
- **Type Safety**: All inputs and outputs are validated against the contract schemas

## Key Concepts

### Unified Contract

The unified contract (`orderProcessingContract`) defines:

- Global activities: `sendNotification`, `purgeExpiredOrders`
- Workflow: `processOrder`
  - Activities: `processPayment` (with the `PaymentDeclined` typed error), `reserveInventory`, `releaseInventory`, `createShipment`, `refundPayment`
  - Signals: `approveOrder` (payload), `cancelRequested` (payload-less)
  - Query: `getOrderStatus` (argument-less)
  - Errors: `PaymentDeclined`
- Workflow: `cleanupExpiredOrders` (activity-less; started by the schedule)

### Worker Implementation

The worker (`examples/order-processing-worker`) uses `@temporal-contract/worker` with:

- Activities returning unthrown `AsyncResult` values (never throwing), with
  `ApplicationFailure` for technical faults and typed constructors for
  contract errors
- Clean Architecture with dependency injection
- Standalone TypeScript application

### Client Perspective

The client interacts with the worker through the shared contract, demonstrating the power of contract-driven development.

## License

MIT
