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
  client: temporalClient,
  interceptors: [tracing, retryTransient], // first entry is outermost
}).get();
```

Interceptors live on the connection-scoped root, so every contract-bound
client obtained via `client.for(contract)` inherits the same chain.

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

`next({ input })` shallow-merges a patch over the invocation before validation.
A patch may carry only the two payload fields — `input`, and `signalInput` for
`signalWithStart`. The identity fields (`operation`, `workflowName`,
`workflowId`, `name`) describe _which_ call is in flight and are owned by the
call site; any other key smuggled into the patch object is dropped, so an
interceptor cannot relabel a call mid-chain:

```typescript
const tracing: ClientInterceptor = (args, next) => {
  const span = tracer.startSpan(`temporal.${args.operation}`, {
    attributes: { "workflow.id": args.workflowId, "workflow.type": args.workflowName },
  });

  return (
    next({
      input: {
        ...(args.input as Record<string, unknown>),
        traceparent: span.spanContext().traceId,
      },
    })
      // `.tap()` fires only on `ok`, so ending the span there alone leaks it on
      // every failure. `.tapFailure()` runs on both the `err` and `defect`
      // channels, so the span is ended exactly once whatever the outcome.
      .tap(() => span.end())
      .tapFailure(() => {
        span.setStatus({ code: SpanStatusCode.ERROR });
        span.end();
      })
  );
};
```

::: tip When the span export itself can fail
`span.end()` returns nothing, so `tap` / `tapFailure` are the right tools. If
your effect _returns a `Result`_ — flushing to a collector that can fail, say —
reach for the effect-returning surface instead: `flatTap` on the `ok` side and
`flatTapErrCases` on the `err` side, so the effect's own failure threads through
rather than being silently dropped.
:::

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

Modeled domain errors (`WorkflowNotInContractError`, a `ContractError`, a validation
failure) stay on the `err` channel. Branch on those with `flatMapErrCases`:

```typescript
import { ErrAsync, OkAsync, P } from "unthrown";

const fallback: ClientInterceptor = (args, next) =>
  next().flatMapErrCases((matcher) =>
    matcher
      // Idempotent start: treat "already running" as success.
      .with(P.tag("@temporal-contract/WorkflowAlreadyStartedError"), () => OkAsync())
      // The matcher must cover the whole union — `P._` passes the rest through.
      .with(P._, (error) => ErrAsync(error)),
  );
```

::: warning The matcher is exhaustive
`flatMapErrCases`, `mapErrCases`, `tapErrCases`, and `recoverErrCases` all
require a match that covers every member of the error union — every member of
`ClientCallError`, which now also carries the widened outcome errors
(`WorkflowCancelledError`, `WorkflowTerminatedError`, `WorkflowTimeoutError`) and
the update/query errors (`UpdateFailedError`, `UpdateRejectedError`,
`QueryFailedError`). A single `.with(P.tag(...))` arm will not compile. Handle
the cases you care about, then close with `P._`.
:::

Calling `next()` twice re-runs the rest of the chain, so retries compose.

## Short-circuit

Return your own result without calling `next`:

```typescript
import { fromSafePromise } from "unthrown";

const readOnlyGuard: ClientInterceptor = (args, next) => {
  if (maintenanceMode && args.operation !== "query") {
    // Maintenance mode is a technical fault, not a domain outcome, so it
    // belongs on the defect channel. `fromSafePromise` turns any throw from
    // the thunk into a defect, giving an AsyncResult<never, never>.
    return fromSafePromise(async () => {
      throw new RuntimeClientError(args.operation, new Error("maintenance mode: writes disabled"));
    });
  }
  return next();
};
```

::: warning Do not put `RuntimeClientError` on the `err` channel
`ClientCallError` does not include it — since 8.0 it rides the defect channel.
`Err(new RuntimeClientError(...))` is both a type error and the wrong channel.

There is no exported bare `Defect` constructor. Produce one by throwing inside
`fromSafePromise` / `fromSafeThrowable`, or via the `defect` helper passed as
the **second argument** to every `*ErrCases` callback and to a `fromPromise`
qualifier:

```typescript
next().mapErrCases(
  (matcher, defect) => matcher.with(P._, (error) => defect(error)), // demote every modeled error
);
```

:::

To short-circuit with a _modeled_ outcome instead, return a success
(`OkAsync`):

```typescript
const skipInReadOnly: ClientInterceptor = (args, next) =>
  maintenanceMode && args.operation === "signal" ? OkAsync() : next();
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
