---
title: Troubleshooting - Common Issues and Solutions
description: Solutions to common issues with temporal-contract, Temporal.io, TypeScript, and workflow development. Troubleshoot connection, validation, type errors, and worker problems.
---

# Troubleshooting

Common issues and their solutions when using **temporal-contract**.

## Connection Issues

### "Connection refused" or "ECONNREFUSED"

**Symptoms:**

```
Error: connect ECONNREFUSED 127.0.0.1:7233
```

**Cause:** Temporal server is not running or not accessible at the specified address.

**Solutions:**

1. **Check if Temporal is running:**

   ```bash
   # Using Docker
   docker ps | grep temporal

   # Check if port 7233 is listening
   netstat -an | grep 7233
   # or
   lsof -i :7233
   ```

2. **Start Temporal:**

   ```bash
   # Using Temporal CLI
   temporal server start-dev

   # Or using Docker Compose
   docker-compose up -d temporal
   ```

3. **Verify connection address:**

   ```typescript
   // ✅ Correct format
   const connection = await Connection.connect({ address: "localhost:7233" });

   // ❌ Common mistakes
   const connection = await Connection.connect({ address: "localhost" }); // Missing port
   const connection = await Connection.connect({ address: "http://localhost:7233" }); // Protocol not needed
   ```

4. **Check firewall/network:**
   ```bash
   # Test connection
   telnet localhost 7233
   # or
   nc -zv localhost 7233
   ```

### "Namespace not found"

**Symptoms:**

```
Error: Namespace "my-namespace" not found
```

**Cause:** The namespace doesn't exist in Temporal.

**Solutions:**

1. **Create the namespace:**

   ```bash
   # Using Temporal CLI
   temporal operator namespace create my-namespace
   ```

2. **Use default namespace:**

   ```typescript
   // Default namespace is "default"
   const client = new Client({
     connection,
     namespace: "default",
   });
   ```

3. **Check Temporal Web UI:**
   - Open [http://localhost:8233](http://localhost:8233)
   - Verify namespace exists under "Namespaces"

## TypeScript Errors

### "Type 'X' is not assignable to type 'Y'"

**Symptoms:**

```typescript
Type '{ orderId: string; }' is not assignable to type 'OrderInput'.
Property 'customerId' is missing.
```

**Cause:** Workflow input doesn't match the schema defined in your contract.

**Solution:** Provide all required fields:

```typescript
// ❌ Missing required field
client.executeWorkflow("processOrder", {
  workflowId: "order-123",
  args: {
    orderId: "ORD-123",
    // Missing 'customerId' and 'amount'
  },
});

// ✅ All required fields
client.executeWorkflow("processOrder", {
  workflowId: "order-123",
  args: {
    orderId: "ORD-123",
    customerId: "CUST-456",
    amount: 99.99,
  },
});
```

### "Property 'X' does not exist on type 'Y'"

**Symptoms:**

```typescript
Property 'transactionId' does not exist on type 'never'.
```

**Cause:** TypeScript cannot infer types properly from the contract.

**Solutions:**

1. **Ensure contract is properly typed:**

   ```typescript
   // ✅ Export contract as const
   export const contract = defineContract({
     // ...
   });

   // ❌ Don't use 'any' or lose type information
   export const contract: any = defineContract({
     // ...
   });
   ```

2. **Use correct type inference with ActivitiesHandler:**

   ```typescript
   import type { ActivitiesHandler } from "@temporal-contract/worker/activity";
   import { contract } from "./contract.js";

   type MyHandlers = ActivitiesHandler<typeof contract>;
   // Use MyHandlers["processPayment"] to type individual activity implementations
   ```

3. **Check activity handler types:**
   ```typescript
   // ✅ Input is automatically typed
   activities: {
     processOrder: {
       processPayment: ({ customerId, amount }) => {
         console.log(customerId);  // Type-safe!
         return Ok({ transactionId: "tx-123" }).toAsync();
       },
     },
   }
   ```

### "Cannot find module" or "Module not found"

**Symptoms:**

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module './contract'
```

**Cause:** Missing `.js` extension in imports (required for ESM).

**Solution:** Always use `.js` extensions:

```typescript
// ❌ Missing extension
import { contract } from "./contract";

// ✅ With extension
import { contract } from "./contract.js";
```

::: tip
Even though your file is `contract.ts`, you must import it as `contract.js` when using ESM!
:::

### "moduleResolution" or "module" errors

**Symptoms:**

```
Module resolution kind 'Node' is not supported for ES6 module output.
```

**Cause:** Incorrect TypeScript configuration.

**Solution:** Update `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "esModuleInterop": true,
    "strict": true
  }
}
```

## Validation Errors

### "Validation failed: expected string, received number"

**Symptoms:**

```
Error: Validation failed: [
  {
    "code": "invalid_type",
    "expected": "string",
    "received": "number",
    "path": ["orderId"]
  }
]
```

**Cause:** Workflow input doesn't match the Zod/Valibot/ArkType schema.

**Solution:** Ensure data types match the schema:

```typescript
// Schema
const contract = defineContract({
  taskQueue: "orders",
  workflows: {
    processOrder: {
      input: z.object({
        orderId: z.string(),
        amount: z.number(),
      }),
      // ...
    },
  },
});

// ❌ Wrong types
client.executeWorkflow("processOrder", {
  workflowId: "order-123",
  args: {
    orderId: 123, // Should be string!
    amount: "99.99", // Should be number!
  },
});

// ✅ Correct types
client.executeWorkflow("processOrder", {
  workflowId: "order-123",
  args: {
    orderId: "ORD-123", // String
    amount: 99.99, // Number
  },
});
```

### "Required field missing"

**Symptoms:**

```
Error: Validation failed: [
  {
    "code": "invalid_type",
    "expected": "string",
    "received": "undefined",
    "path": ["customerId"]
  }
]
```

**Cause:** Starting workflow with missing required fields.

**Solution:** Provide all required fields in the schema.

## Worker Issues

### "Task queue not found" or "No worker polling"

**Symptoms:**

- Workflow hangs and doesn't progress
- Activities never execute
- Timeout errors

**Cause:** No worker is polling the task queue.

**Solutions:**

1. **Start the worker:**

   ```typescript
   const worker = await Worker.create({
     workflowsPath: require.resolve("./workflows"),
     activities,
     taskQueue: contract.taskQueue,
   });

   await worker.run();
   ```

2. **Verify task queue matches:**

   ```typescript
   // Contract
   const contract = defineContract({
     taskQueue: "orders", // ⚠️ Must match worker
     // ...
   });

   // Worker
   const worker = await Worker.create({
     taskQueue: "orders", // ⚠️ Must match contract
     // ...
   });
   ```

3. **Check Temporal Web UI:**
   - Open [http://localhost:8233](http://localhost:8233)
   - Go to workflow -> Task Queue
   - Verify workers are polling

### "Activity execution failed"

**Symptoms:**

```
Error: Activity task failed: ApplicationFailure
```

**Cause:** Activity threw an error or returned an error result.

**Solutions:**

1. **Check activity implementation:**

   ```typescript
   // ✅ Return proper error result
   processPayment: ({ customerId, amount }) =>
     fromPromise(paymentService.charge(customerId, amount), (e) =>
       ApplicationFailure.create({
         type: "PAYMENT_FAILED",
         message: e instanceof Error ? e.message : "Payment failed",
         cause: e instanceof Error ? e : undefined,
       }),
     ).map((tx) => ({ transactionId: tx.id }));
   ```

2. **Handle errors in workflow:**

   ```typescript
   implementation: async ({ activities }, input) => {
     try {
       const payment = await activities.processPayment(input);
       return { status: "success", transactionId: payment.transactionId };
     } catch (error) {
       // Handle activity failure
       return { status: "failed", transactionId: undefined };
     }
   };
   ```

3. **Configure retries:**
   ```typescript
   // Activities automatically retry by default
   // Check Temporal retry policies if needed
   ```

### "Workflow bundle not found"

**Symptoms:**

```
Error: Cannot find module './workflows'
```

**Cause:** Workflow file path is incorrect or not bundled.

**Solutions:**

1. **Use correct path:**

   ```typescript
   // ✅ Use require.resolve for correct path
   const worker = await Worker.create({
     workflowsPath: require.resolve("./workflows"),
     // ...
   });
   ```

2. **Ensure workflows export correctly:**

   ```typescript
   // workflows.ts - export all workflows
   export { processOrder } from "./processOrder.js";
   export { cancelOrder } from "./cancelOrder.js";
   ```

3. **Check build output:**
   - Ensure TypeScript compiles workflows
   - Check that output directory contains workflow files

## Result / AsyncResult Pattern Issues

### "Cannot read property 'match' of undefined"

**Symptoms:**

```
TypeError: Cannot read property 'match' of undefined
```

**Cause:** Activity returned `undefined` instead of an `AsyncResult`.

**Solution:** Always return an `AsyncResult` from activities:

```typescript
// ❌ Returns undefined
processPayment: () => {
  paymentService.charge();
  // No return!
};

// ✅ Returns AsyncResult<T, E>
processPayment: ({ customerId, amount }) =>
  fromPromise(paymentService.charge(customerId, amount), (e) =>
    ApplicationFailure.create({
      type: "PAYMENT_FAILED",
      message: e instanceof Error ? e.message : "Payment failed",
    }),
  ).map((tx) => ({ transactionId: tx.id }));
```

### "ok is not a function" / "Result.Ok is not a function"

**Symptoms:**

```
TypeError: Result.Ok is not a function
```

**Cause:** Code is still using the old `@swan-io/boxed` API
(`Result.Ok` / `Result.Error`), the `neverthrow` API (`okAsync` /
`errAsync` / `ResultAsync`), or importing from a package that no longer
exists. The previous `@temporal-contract/boxed` package was removed when the
library moved to `neverthrow`, and `neverthrow` was later replaced by
`unthrown`.

**Solution:** Use `unthrown` (note: there is no `okAsync` / `errAsync` —
lift a sync `Result` with `.toAsync()`):

```typescript
// ✅ For activities, workflows, and clients
import { fromPromise, ok, err, isOk, isErr, isDefect, type AsyncResult } from "unthrown";

// okAsync(value)  -> Ok(value).toAsync()
// errAsync(error) -> Err(error).toAsync()
```

See [Migrating from neverthrow](/guide/migrating-to-unthrown) for the full
mapping.

## Performance Issues

### Slow workflow execution

**Symptoms:**

- Workflows take longer than expected
- High latency between activities
- Worker resource exhaustion

**Solutions:**

1. **Optimize activity implementation:**

   ```typescript
   // ❌ Blocking operation
   processOrder: ({ payload }) => fromPromise(fetch("http://slow-api.com/process"), (e) => e);

   // ✅ Add timeouts and handle slow operations
   processOrder: ({ payload }) =>
     fromPromise(
       Promise.race([
         fetch("http://api.com/process"),
         new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 5000)),
       ]),
       (e) => e,
     );
   ```

2. **Configure worker capacity:**

   ```typescript
   const worker = await Worker.create({
     // ...
     maxConcurrentActivityTaskExecutions: 100,
     maxConcurrentWorkflowTaskExecutions: 100,
   });
   ```

3. **Use async activities appropriately:**
   - Long-running operations should use heartbeats
   - Consider breaking large workflows into child workflows

### Memory issues

**Symptoms:**

- Worker memory grows over time
- Out of memory errors

**Solutions:**

1. **Limit concurrent executions:**

   ```typescript
   const worker = await Worker.create({
     // ...
     maxConcurrentActivityTaskExecutions: 50, // Lower if memory constrained
     maxConcurrentWorkflowTaskExecutions: 50,
   });
   ```

2. **Graceful shutdown:**
   ```typescript
   process.on("SIGINT", async () => {
     await worker.shutdown();
     process.exit(0);
   });
   ```

## Still Having Issues?

If your problem isn't listed here:

1. **Check GitHub Issues:**
   - [Search existing issues](https://github.com/btravstack/temporal-contract/issues)
   - [Open a new issue](https://github.com/btravstack/temporal-contract/issues/new)

2. **Review Documentation:**
   - [Core Concepts](/guide/core-concepts)
   - [Client Usage](/guide/client-usage)
   - [Worker Usage](/guide/worker-usage)

3. **Check Examples:**
   - [Basic Order Processing](/examples/basic-order-processing)

4. **Temporal Resources:**
   - [Temporal Documentation](https://docs.temporal.io/)
   - [Temporal Community Forum](https://community.temporal.io/)

::: tip Need More Help?
When asking for help, please provide:

- temporal-contract version (check `package.json`)
- Node.js version (`node --version`)
- TypeScript version (`npx tsc --version`)
- Temporal server version
- Complete error message and stack trace
- Minimal reproduction code
  :::
