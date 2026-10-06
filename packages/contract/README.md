# @temporal-contract/contract

> Contract builder and type definitions for Temporal workflows and activities

[![npm version](https://img.shields.io/npm/v/@temporal-contract/contract.svg?logo=npm)](https://www.npmjs.com/package/@temporal-contract/contract)

## Installation

```bash
# 8.0 beta — `latest` still resolves 7.x
pnpm add @temporal-contract/contract@beta

# Plus one Standard Schema validator of your choice — zod, valibot, arktype, …
pnpm add zod

# Optional peer, needed only for the `@temporal-contract/contract/errors` entry
pnpm add unthrown
```

## Quick Example

```typescript
import { defineContract, defineWorkflow } from "@temporal-contract/contract";
import { z } from "zod";

const processOrder = defineWorkflow({
  input: z.object({ orderId: z.string() }),
  output: z.object({ success: z.boolean() }),
  // Required: the workflowIdReusePolicy for a start under an existing ID.
  startPolicy: "once-per-id",
  activities: {/* ... */},
});

export const myContract = defineContract({
  taskQueue: "orders",
  workflows: { processOrder },
});
```

## Documentation

📖 **[Read the full documentation →](https://btravstack.github.io/temporal-contract)**

- [API Reference](https://btravstack.github.io/temporal-contract/api/contract)
- [Your first workflow](https://btravstack.github.io/temporal-contract/tutorial/your-first-workflow)
- [Why temporal-contract?](https://btravstack.github.io/temporal-contract/explanation/why-temporal-contract)

## License

MIT
