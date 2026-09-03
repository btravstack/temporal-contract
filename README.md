<div align="center">

<img src="docs/public/logo.svg" alt="temporal-contract" width="128" height="128" />

# temporal-contract

**Type-safe contracts for Temporal.io**

End-to-end type safety and runtime validation for workflows and activities

[![CI](https://github.com/btravstack/temporal-contract/actions/workflows/ci.yml/badge.svg)](https://github.com/btravstack/temporal-contract/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@temporal-contract/contract.svg?logo=npm)](https://www.npmjs.com/package/@temporal-contract/contract)
[![npm downloads](https://img.shields.io/npm/dm/@temporal-contract/contract.svg)](https://www.npmjs.com/package/@temporal-contract/contract)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.0-blue?logo=typescript)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

[**Documentation**](https://btravstack.github.io/temporal-contract) · [**Tutorial**](https://btravstack.github.io/temporal-contract/tutorial/your-first-workflow) · [**Reference**](https://btravstack.github.io/temporal-contract/reference/contract-surface) · [**Sample coverage**](EXAMPLES.md)

</div>

## The problem

Temporal invokes workflows by **string name** with **positional arguments**:

```typescript
await client.workflow.execute("processOrder", {
  taskQueue: "orders",
  workflowId: "order-123",
  args: [{ orderId: "ORD-1", amount: 99.99 }],
});
```

Nothing here is checked — not the name, not the queue, not the argument shape.
The client and the worker are usually different deployments on different release
cadences, so `typeof activities` is a claim nobody verifies. Rename a field and
the workflow reads `undefined`, runs to completion, and does the wrong thing —
durably.

## What this does

Declare the shape once; both sides import it.

```typescript
import { defineActivity, defineContract, defineWorkflow } from "@temporal-contract/contract";
import { z } from "zod";

const chargeCard = defineActivity({
  input: z.object({ customerId: z.string(), amount: z.number().positive() }),
  output: z.object({ transactionId: z.string() }),
});

const processOrder = defineWorkflow({
  input: z.object({ orderId: z.string(), customerId: z.string(), amount: z.number().positive() }),
  output: z.object({ orderId: z.string(), transactionId: z.string() }),
  // Payment already moved money on success — block a second successful
  // run per order. A start is still retryable after a genuinely failed
  // attempt (e.g. a declined payment, where no charge went through).
  idempotency: "retry-if-failed",
  activities: { chargeCard },
});

export const orderContract = defineContract({
  taskQueue: "orders",
  workflows: { processOrder },
});
```

Implement the activities — note that workflow-scoped activities nest under their
workflow, mirroring the contract:

```typescript
import { declareActivitiesHandler, qualifyFailure } from "@temporal-contract/worker/activity";
import { fromPromise } from "unthrown";

export const activities = declareActivitiesHandler({
  contract: orderContract,
  activities: {
    processOrder: {
      chargeCard: ({ input: { customerId, amount } }) =>
        fromPromise(
          gateway.charge(customerId, amount),
          // `expected` names the failures this activity anticipates; anything
          // else rides the defect channel with its original stack.
          qualifyFailure("CHARGE_FAILED", { expected: GatewayError }),
        ).map((charge) => ({ transactionId: charge.id })),
    },
  },
});
```

Call it — names, arguments, and results all typed, and validated at runtime:

```typescript
import { P } from "unthrown";

const result = await client.executeWorkflow("processOrder", {
  workflowId: "order-123",
  args: { orderId: "ORD-1", customerId: "CUST-1", amount: 99.99 },
});

result.match({
  ok: (output) => console.log(output.transactionId),
  errCases: (matcher) =>
    matcher.with(
      P.tag("@temporal-contract/WorkflowValidationError"),
      P.tag("@temporal-contract/WorkflowFailedError"),
      // ...exhaustive — a missing tag is a compile error
      (error) => console.error(error.message),
    ),
  defect: (cause) => console.error("unexpected:", cause),
});
```

An invalid call is rejected **before** a workflow is started — no history, no
partial state, nothing to unwind.

## Features

- **End-to-end type safety** — workflows, activities, signals, queries, updates,
  errors, and search attributes all derive from one contract
- **Validation at every boundary** — Standard Schema (Zod, Valibot, ArkType) runs
  on both sides of every network hop: validated on send, parsed on receive, so
  transforms apply exactly once
- **Typed domain errors** — declare failures on the contract; consume them as
  schema-validated values with an exhaustive matcher
- **Explicit error handling** — `Result` / `AsyncResult` from
  [unthrown](https://github.com/btravstack/unthrown), with a separate `defect`
  channel that keeps genuine bugs loud
- **Child workflows** — typed, including across contracts and teams
- **Schedules, cancellation scopes, continue-as-new, activity middleware** —
  all contract-aware
- **Testing utilities** — time-skipping (no Docker) and real-server
  (testcontainers) fixtures
- **Nexus** — not implemented; see
  [the status page](https://btravstack.github.io/temporal-contract/explanation/nexus)

## Install

> **8.0 is currently a prerelease.** npm's `latest` tag still resolves to 7.x,
> while this README documents the v8 API. Install the `@temporal-contract/*`
> packages with the `beta` tag until 8.0 is stable — a plain
> `pnpm add @temporal-contract/contract` gives you the previous major.

```bash
# Core packages (8.0 beta — `latest` still resolves 7.x)
pnpm add @temporal-contract/contract@beta @temporal-contract/worker@beta \
         @temporal-contract/client@beta

# Peer dependencies (stable releases)
pnpm add unthrown \
  @temporalio/client @temporalio/common @temporalio/worker @temporalio/workflow

# Plus one Standard Schema validator of your choice — zod, valibot, arktype, …
pnpm add zod
```

Requires **Node.js ≥ 22.22**, ESM (`"type": "module"`), and TypeScript `strict`.
Developed against **TypeScript 6.0**.

> Install `unthrown` explicitly even if your package manager auto-installs
> peers — your own code imports its `Result` / `AsyncResult` types, so it is a
> real dependency of yours. It must resolve to **v5**.

See [Install](https://btravstack.github.io/temporal-contract/how-to/install) for
the per-process breakdown.

## Documentation

📖 **[btravstack.github.io/temporal-contract](https://btravstack.github.io/temporal-contract)**

Organized by [Diátaxis](https://diataxis.fr/):

|                                                                                                 |                                |
| ----------------------------------------------------------------------------------------------- | ------------------------------ |
| [Tutorial](https://btravstack.github.io/temporal-contract/tutorial/your-first-workflow)         | Build a working app end to end |
| [How-to guides](https://btravstack.github.io/temporal-contract/how-to/install)                  | Recipes for specific problems  |
| [Reference](https://btravstack.github.io/temporal-contract/reference/contract-surface)          | Every option, type, and error  |
| [Explanation](https://btravstack.github.io/temporal-contract/explanation/why-temporal-contract) | Why it works this way          |

## Packages

| Package                                            | Description                                 |
| -------------------------------------------------- | ------------------------------------------- |
| [@temporal-contract/contract](./packages/contract) | Contract builders, types, and errors        |
| [@temporal-contract/worker](./packages/worker)     | Workflow, activity, and worker entry points |
| [@temporal-contract/client](./packages/client)     | Typed client, handles, and schedules        |
| [@temporal-contract/testing](./packages/testing)   | Time-skipping and testcontainers fixtures   |

All four version together as a fixed release group — one version number
describes a compatible set.

## Stability

The contract API (`defineContract`, `declareWorkflow`, `declareActivitiesHandler`,
`TypedClient`) is stable. Earlier major bumps were migrations of the underlying
result library, now settled on [unthrown](https://github.com/btravstack/unthrown);
there are no plans to switch again. The `unthrown` peer range tracks its current
major line, and each raise is documented in the changelog with migration notes.

Upgrading from 7.x? See
[Upgrade to v8](https://btravstack.github.io/temporal-contract/how-to/upgrade-to-v8).

## Contributing

See [CONTRIBUTING.md](https://github.com/btravstack/temporal-contract/blob/main/CONTRIBUTING.md).

## License

MIT
