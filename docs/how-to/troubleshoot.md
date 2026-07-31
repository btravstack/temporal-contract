# Troubleshoot

Common failures, what causes them, and what to change.

## Module resolution

### `ERR_MODULE_NOT_FOUND` on a relative import

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/app/src/contract' imported from /app/src/worker.ts
```

The extension is missing. ESM requires it, and it must be `.js` even when the
file on disk is `.ts`:

```typescript
import { orderContract } from "./contract.js"; // ✅
import { orderContract } from "./contract"; // ❌
import { orderContract } from "./contract.ts"; // ❌
```

### `require() of ES Module not supported`

The packages are ESM-only. Set `"type": "module"` in `package.json` and use
`nodenext` module resolution.

### `Cannot find module '@temporal-contract/worker'`

The worker package has no root export — import from a subpath:

```typescript
import { declareActivitiesHandler } from "@temporal-contract/worker/activity";
import { declareWorkflow } from "@temporal-contract/worker/workflow";
import { TypedWorker } from "@temporal-contract/worker/worker";
```

## Type errors

### `Property 'x' does not exist on type` for an activity

The implementation is at the wrong nesting level. Activities declared on a
_workflow_ nest under that workflow's name; only contract-level activities sit
at the root:

```typescript
declareActivitiesHandler({
  contract: orderContract,
  activities: {
    sendNotification: (...) => ...,     // global — root level
    processOrder: {                      // workflow-scoped — nested
      chargeCard: (...) => ...,
    },
  },
});
```

### Inference collapses to `any`

`strict` is off. The contract's type inference depends on it:

```json
{ "compilerOptions": { "strict": true } }
```

### Two different `unthrown` copies

```
Type 'AsyncResult<T, E>' is not assignable to type 'AsyncResult<T, E>'
```

Two copies are installed. Check and dedupe:

```bash
pnpm why unthrown
pnpm dedupe
```

`unthrown` is a peer dependency precisely so there is one copy. Add it to your
own `package.json` rather than relying on a transitive install.

### Missing arm in `errCases`

```
Argument of type '...' is not assignable to parameter of type 'never'
```

The matcher is exhaustive and a tag is unhandled. Add the arm, or use `P._` for
a genuine catch-all:

```typescript
import { P } from "unthrown";

matcher.with(P._, (error) => handle(error));
```

## Validation errors

### `Validation failed for workflow "x" input`

The arguments do not satisfy the input schema. The issues array names the
offending fields:

```typescript
if (result.isErr() && result.error instanceof WorkflowValidationError) {
  console.error(result.error.issues);
}
```

Check for `z.number()` receiving a numeric string, a `Date` where the schema
says `z.string()`, or a required field the caller omits.

### Output validation fails but the workflow looks right

The implementation returns something the output schema rejects — often an
extra field under a strict schema, or `undefined` where the schema requires a
value. Validation runs _after_ your implementation returns.

### `Contract validation failed: ...` at import time

`defineContract` rejected the structure. The message names the problem:

```
Contract validation failed: taskQueue cannot be empty
Contract validation failed: at least one workflow is required
Contract validation failed: input must be a Standard Schema compatible schema
```

For a duplicate activity name:

```
workflow "cancelOrder" has activity "chargeCard" that conflicts with the
same-named activity in workflow "processOrder".
```

Activities share one flat namespace at runtime. Rename one, or promote it to a
global activity.

### A query fails at runtime with a schema complaint

Query schemas must validate **synchronously**. An async refinement
(`z.string().refine(async ...)`) cannot work — Temporal requires query handlers
to complete synchronously, so the worker throws when a schema returns a
`Promise`.

## Worker problems

### The worker starts but nothing executes

The client and worker are on different task queues or namespaces. Both derive
the queue from the contract, so check they import the _same_ contract, and that
`namespace` matches on both sides.

Confirm the worker is polling:

```bash
temporal task-queue describe --task-queue orders
```

### `Failed to create Temporal worker for task queue "..."`

A `TechnicalError` on the defect channel — bundling failed, or the connection
did not open. Inspect the cause:

```typescript
const result = await TypedWorker.create({ ... });
if (result.isDefect()) {
  console.error(result.cause);        // TechnicalError
  console.error(result.cause.cause);  // the underlying failure
}
```

The most common cause is a workflow file importing something that cannot be
bundled — see below.

### Workflow bundling fails

Workflow code runs in an isolated deterministic sandbox. It cannot import
anything with Node built-ins or side effects — database drivers, HTTP clients,
`fs`.

```typescript
// ❌ workflows.ts
import { db } from "./database.js"; // pulls in a driver → bundle fails

// ✅ workflows.ts
import { declareWorkflow } from "@temporal-contract/worker/workflow";
import { orderContract } from "./contract.js"; // schemas only
```

Move the dependency into an activity. See
[Architecture](/explanation/architecture).

### `workflowsPath` does not resolve after building

Include the extension, and write `.js`:

```typescript
workflowsPath: workflowsPathFromURL(import.meta.url, "./workflows.js");
```

Also confirm your build actually emits `workflows.js` next to `worker.js`.

## Determinism

### `Nondeterminism error` on replay

The workflow code took a different path on replay than it did originally.
Usually one of:

- `Date.now()`, `new Date()`, `Math.random()`, or `crypto.randomUUID()` in
  workflow code — use `@temporalio/workflow`'s patched `Date`, `uuid4()`, or
  push the value into an activity;
- `setTimeout` instead of `sleep()`;
- reading `process.env` or a module-level mutable;
- iterating a `Set` or `Map` built from a non-deterministic source;
- deploying changed workflow logic while old executions are still running.

For the last one, use Temporal's `patched()` / `deprecatePatch()` versioning
API. See [Workflow determinism](/explanation/workflow-determinism).

### Logs repeat on every replay

`console.log` in workflow code re-fires on replay. Use the replay-safe logger:

```typescript
import { log } from "@temporalio/workflow";

log.info("processing order", { orderId });
```

## Result and error handling

### `.get()` does not compile on a result that can fail

`.get()` is defined **only** when the error channel is empty (`E = never`) — it
is for results that cannot fail, like the `AsyncResult<…, never>` that
`TypedWorker.create` and `TypedClient.create` return. On a result with a modeled
error it will not compile at all — `.get()` never accepts an `Err`. (The
`GetError` class still exists, but only as a defensive runtime guard against an
unsound cast past the type gate; well-typed code never reaches it.) Reach for
the extractor that matches your intent:

| Method             | Compiles when    | On `Err`                | On `Defect`        |
| ------------------ | ---------------- | ----------------------- | ------------------ |
| `.get()`           | `E = never`      | — (cannot fail)         | rethrows the cause |
| `.getOrThrow()`    | `E` is non-empty | throws the error itself | rethrows the cause |
| `.getOr(fallback)` | any              | returns the fallback    | rethrows the cause |
| `.getOrNull()`     | any              | `null`                  | rethrows the cause |

Every extractor rethrows a defect — that is intentional. To branch on a modeled
error instead of throwing, narrow with `isErr()` first.

### A failure I expected on `err` arrives as a `defect`

Since 8.0, `TechnicalError` and `RuntimeClientError` ride the defect channel.
Handle them in `defect`, `recoverDefect`, or `tapDefect`:

```typescript
import { P } from "unthrown";

result.match({
  ok: (v) => v,
  errCases: (m) => m.with(P.tag("@temporal-contract/WorkflowFailedError"), handle),
  defect: (cause) => {
    if (cause instanceof RuntimeClientError) return report(cause);
    throw cause;
  },
});
```

See [Upgrade to v8](/how-to/upgrade-to-v8).

### `Error "X" is not declared on activity "y"`

You raised a contract error whose name is not in that activity's `errors` map.
The message lists what _is_ declared. Add it to the contract or fix the name.

## Activity behaviour

### An activity retries forever

No `maximumAttempts`, and the failure is retryable. Either cap the attempts or
mark the failure permanent:

```typescript
retry: {
  maximumAttempts: 5;
}
```

```typescript
// `expected` is required — name the anticipated class (or a predicate).
qualifyFailure("CARD_DECLINED", { expected: CardDeclinedError, nonRetryable: true });
```

### An activity is not retried at all

Something upstream set `nonRetryable: true`, or the type is listed in
`retry.nonRetryableErrorTypes`.

Watch for `qualifyFailure` re-typing a matched failure: a cause matching
`expected` is always wrapped into a fresh `ApplicationFailure` with the declared
`type`. When you omit `nonRetryable`, the wrapper _inherits_ a matched inner
`ApplicationFailure`'s own `nonRetryable: true` (a permanent inner failure no
longer silently becomes retryable); pass `{ nonRetryable: false }` to force it
retryable, or `{ nonRetryable: true }` to make it permanent regardless.

### An activity times out but the work finished

`startToCloseTimeout` is shorter than a healthy attempt. Raise it, and for
long-running work add heartbeats plus a `heartbeatTimeout` — a non-heartbeating
activity is presumed dead.

### A cancelled workflow keeps running

Something is swallowing the cancellation. Re-throw it:

```typescript
import { isCancellation } from "@temporalio/workflow";

catch (error) {
  if (isCancellation(error)) throw error;
  log.warn(`non-critical step failed: ${error}`);
}
```

## Still stuck

- Inspect the execution history in the Web UI (<http://localhost:8233> for a dev
  server) — it records every event including failures and retries.
- Check the [errors reference](/reference/errors) for what a specific error
  class means and where it comes from.
- [Open an issue](https://github.com/btravstack/temporal-contract/issues) with
  your contract, the failing code, and the full error.
