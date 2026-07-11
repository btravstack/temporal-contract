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

const connection = await Connection.connect({ address: "localhost:7233" });
const temporalClient = new Client({ connection });
const client = await TypedClient.create({ contract: myContract, client: temporalClient }).getOrElse(
  (error) => {
    throw error;
  },
);

// Execute workflow (fully typed!)
const result = await client.executeWorkflow("processOrder", {
  workflowId: "order-123",
  args: { orderId: "ORD-123" },
});
```

## Documentation

📖 **[Read the full documentation →](https://btravstack.github.io/temporal-contract)**

- [API Reference](https://btravstack.github.io/temporal-contract/api/client)
- [Getting Started](https://btravstack.github.io/temporal-contract/guide/getting-started)
- [Examples](https://btravstack.github.io/temporal-contract/examples/)

## License

MIT
