# Intercept client calls

Client interceptors wrap typed-client operations — the seam for trace
propagation, retries, metrics, and audit logging.

They wrap the operation **outside** the validation pipeline, but a patched input
is validated exactly like the caller's original, so an interceptor cannot
smuggle unvalidated data past the contract.

## Register them

```typescript
import { TypedClient, type ClientInterceptor } from "@temporal-contract/client";

const client = await TypedClient.create({
  contract: orderContract,
  client: temporalClient,
  interceptors: [tracing, retryTransient], // first entry is outermost
}).get();
```

## Which operations are wrapped

`args` is a discriminated union over `operation`:

| `operation`                            | Extra fields                                  |
| -------------------------------------- | --------------------------------------------- |
| `"startWorkflow"`, `"executeWorkflow"` | `workflowName`, `workflowId`, `input`         |
| `"signalWithStart"`                    | the above, plus `signalName`, `signalInput`   |
| `"signal"`, `"query"`, `"update"`      | `workflowName`, `workflowId`, `name`, `input` |

`input` is the caller's raw, not-yet-validated payload.

## Observe

Call `next()` and inspect what comes back:

```typescript
const auditing: ClientInterceptor = (args, next) =>
  next().tap(() => {
    logger.info({ operation: args.operation, workflowId: args.workflowId }, "client call ok");
  });
```

## Add trace context

`next({ input })` shallow-merges a patch over the invocation before validation:

```typescript
const tracing: ClientInterceptor = (args, next) => {
  const span = tracer.startSpan(`temporal.${args.operation}`, {
    attributes: { "workflow.id": args.workflowId, "workflow.type": args.workflowName },
  });

  return next({
    input: {
      ...(args.input as Record<string, unknown>),
      traceparent: span.spanContext().traceId,
    },
  }).tap(() => span.end());
};
```

::: warning The patched field must be on the contract
The patch goes through the same schema validation as the original input. If
`traceparent` is not part of the workflow's input schema, the call fails with
`WorkflowValidationError`. Declare the field on the contract, or carry trace
context in `memo` / `searchAttributes` instead.
:::

For `signalWithStart`, patch `signalInput` to reach the signal payload:

```typescript
next({ signalInput: { ...payload, traceparent } });
```

## Retry a transient failure

Technical faults — a connection blip, a gRPC hiccup — ride the **defect**
channel, not `err`. Retry them with `recoverDefect`:

```typescript
import { RuntimeClientError, type ClientInterceptor } from "@temporal-contract/client";

const retryTransient: ClientInterceptor = (args, next) =>
  next().recoverDefect((cause) => {
    if (cause instanceof RuntimeClientError) {
      return next(); // one more attempt
    }
    throw cause; // not ours — keep it a defect
  });
```

Modeled domain errors (`WorkflowNotFoundError`, a `ContractError`, a validation
failure) stay on the `err` channel. Branch on those with `flatMapErrCases`:

```typescript
const fallback: ClientInterceptor = (args, next) =>
  next().flatMapErrCases((matcher) =>
    matcher.with(tag("@temporal-contract/WorkflowAlreadyStartedError"), () =>
      // Idempotent start: treat "already running" as success.
      Ok(undefined).toAsync(),
    ),
  );
```

Calling `next()` twice re-runs the rest of the chain, so retries compose.

## Short-circuit

Return your own result without calling `next`:

```typescript
const readOnlyGuard: ClientInterceptor = (args, next) => {
  if (maintenanceMode && args.operation !== "query") {
    return Err(
      new RuntimeClientError(args.operation, new Error("maintenance mode: writes disabled")),
    ).toAsync();
  }
  return next();
};
```

## Measure latency

```typescript
const timing: ClientInterceptor = (args, next) => {
  const started = Date.now();
  return next().tap(() => {
    metrics.histogram("temporal.client.duration", Date.now() - started, {
      operation: args.operation,
      workflow: args.workflowName,
    });
  });
};
```

## Ordering

The array composes outermost-first. Put the widest concern first:

```typescript
interceptors: [
  tracing, // outermost: sees every attempt
  retryTransient, // retries the inner call
  timing, // innermost: times a single attempt
];
```

With this order, `tracing` spans all retries while `timing` measures each
attempt individually.

## Client vs activity middleware

|                        | Client interceptor              | [Activity middleware](/how-to/add-activity-middleware) |
| ---------------------- | ------------------------------- | ------------------------------------------------------ |
| Runs in                | The calling process             | The worker process                                     |
| Wraps                  | Client operations               | Activity implementations                               |
| Relative to validation | Outside (patch is re-validated) | Inside (input already validated)                       |
| Typed context          | No                              | Yes, accumulates through the chain                     |

## Next

- [Add activity middleware](/how-to/add-activity-middleware)
- [Client surface](/reference/client-surface)
- [The result model](/explanation/the-result-model) — err vs defect
