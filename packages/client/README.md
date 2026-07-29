# @temporal-contract/client

> Type-safe client for consuming Temporal workflows

[![npm version](https://img.shields.io/npm/v/@temporal-contract/client.svg?logo=npm)](https://www.npmjs.com/package/@temporal-contract/client)

## Installation

```bash
pnpm add @temporal-contract/client @temporal-contract/contract @temporalio/client zod
```

## Quick Example

```typescript
import { TypedClient } from "@temporal-contract/client";
import { Connection, Client } from "@temporalio/client";

import { myContract } from "./contract.js";

const connection = await Connection.connect({ address: "localhost:7233" });
const temporalClient = new Client({ connection });

// One connection-scoped root per process. `create` returns
// `AsyncResult<TypedClient, never>` — setup faults are defects, so `.get()`
// unwraps directly.
const client = await TypedClient.create({ client: temporalClient }).get();

// Bind a contract — synchronous, infallible, memoized.
const orders = client.for(myContract);

// Execute workflow (fully typed!)
const result = await orders.executeWorkflow("processOrder", {
  workflowId: "order-123",
  args: { orderId: "ORD-123" },
});
```

## Documentation

📖 **[Read the full documentation →](https://btravstack.github.io/temporal-contract)**

- [API Reference](https://btravstack.github.io/temporal-contract/api/client)
- [Your first workflow](https://btravstack.github.io/temporal-contract/tutorial/your-first-workflow)
- [Examples](https://btravstack.github.io/temporal-contract/examples/)

## License

MIT
