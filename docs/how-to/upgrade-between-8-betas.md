# Upgrade between 8.0 betas

The 8.0 line went through several breaking passes while on the `beta` tag. This
page lists what changed **between betas** — renames that only ever shipped in a
beta, and APIs a beta added and a later beta took back. If you are coming from
7.x, you need none of this: follow [Upgrade from 7.x to 8.0](/how-to/upgrade-to-v8),
which describes the end state directly.

Sections run oldest first. Apply every section after the beta you are on; the
exhaustive matcher and `pnpm typecheck` point at most of the sites.

## unthrown 5 prereleases

If an intermediate beta had you install `ts-pattern` as a peer (unthrown
`5.0.0-beta.5`), remove it — unthrown's matcher is built in again as of
`5.0.0-beta.6`, and unthrown has zero runtime dependencies:

```bash
pnpm remove ts-pattern
```

The standalone `tag` export is gone in unthrown 5.0.0 — it is `P.tag` now. Drop
`tag` from the import (keeping or adding `P`) and prefix the call sites:

```diff
- import { tag } from "unthrown";
+ import { P } from "unthrown";

  result.mapErrCases((matcher) =>
-   matcher.with(tag("@temporal-contract/WorkflowFailedError"), (error) => handle(error)),
+   matcher.with(P.tag("@temporal-contract/WorkflowFailedError"), (error) => handle(error)),
  );
```

## Renames and removals that only shipped in betas

| In an earlier 8.0 beta                                                                                          | Now                                                                                                                                                             |
| --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `defineWorkflow({ idempotency })`                                                                               | `defineWorkflow({ startPolicy })` — same three values                                                                                                           |
| `IdempotencyMode` (type, then a deprecated alias)                                                               | `WorkflowStartPolicy`, exported from the package root                                                                                                           |
| `propagateActivityFailure`                                                                                      | `propagateFailure` (it always covered child workflows and cancellation scopes too)                                                                              |
| `qualifyFailure("X")`                                                                                           | `qualifyFailure("X", { expected })` — `expected: "any"` keeps the old catch-all deliberately                                                                    |
| `WORKFLOW_START_ERROR_TAGS` / `WORKFLOW_OUTCOME_ERROR_TAGS` / `WORKFLOW_RESULT_ERROR_TAGS`, `tagPatterns(tags)` | the pattern groups `WORKFLOW_START_PATTERNS`, `WORKFLOW_EXECUTE_PATTERNS`, `WORKFLOW_RESULT_PATTERNS`, … — `matcher.with(...WORKFLOW_RESULT_PATTERNS, handler)` |
| `createContractTest(contract, { workflowsPath, activities })`                                                   | `createContractTest({ contract, workflowsPath, activities })`                                                                                                   |
| `runActivity(definition, implementation, input)`                                                                | `runActivity(definition, { implementation, input })`                                                                                                            |
| activity leaf `({ errors, context }, args)` reading `args`                                                      | unchanged, and the first record now also carries `input`: `({ errors, input }) => ...`                                                                          |

`createContractTest`'s `worker` fixture is the `TypedWorker` (the raw Temporal
`Worker` is at `worker.raw`).

### Compile-time contract validation is gone

A beta mirrored `defineContract`'s runtime checks at the type level (reserved
names, `ms` durations, activity-name collisions) and made its type parameter
`const`. Both are removed; the runtime checks were always authoritative and
still run at `defineContract` call time. A contract assembled inside a generic
helper type-checks again, so drop any `defineContract(contract as never)`
workaround.

## Audit hardening (the release after `8.0.0-beta.11`)

A pre-release audit tightened every package. Each item says what to change.

### Contract

- **Validation messages list paths only.** `summarizeIssues` — and so the
  `message` of every client and worker validation error, which lands in
  Temporal history unencrypted — names the failing paths, capped at five
  (`at email; at items[0].qty; …and 3 more`, `at root` for the value itself).
  Schema messages embed raw input values. Read `error.issues` for the detail,
  and update any assertion on the old `at path: message` text.
- **`ContractDefinitionError`.** Definition failures throw this exported
  `Error` subclass with a dotted `path` (`workflows.processOrder.signals.cancel`);
  messages read `Contract validation failed at <path>: …`. Match on
  `instanceof ContractDefinitionError` / `path`, not the message text.
- **Strict keys on every definition** — workflow, activity, signal, query,
  update, error, and search-attribute definitions reject unknown keys (also at
  compile time on the `define*` builders). A leftover `defaultOptions` or
  `idempotency` gets a rename hint; `workflowId` and `idempotencyKey` must be
  functions.
- **`startPolicy` is required at runtime**, not just by type. A beta
  deliberately accepted a missing `startPolicy` at runtime; add it to any
  workflow assembled outside the type system.
- **Retry policies are validated like Temporal does**: `backoffCoefficient`
  below 1, a `maximumAttempts` that is not a positive integer (`Infinity`
  stays allowed), a zero interval, or `maximumInterval` below
  `initialInterval` (1s when unset) fail at `defineContract` instead of
  failing the workflow task.
- **More reserved names** — `Object.prototype` members (`constructor`,
  `toString`, …) as any name; the worker's own failure types
  (`WorkflowInputValidationError`, `ContractMisuseError`, …) as error names;
  Temporal system attributes (`WorkflowId`, `ExecutionStatus`, …) as
  search-attribute names; and one search attribute declared with two kinds
  across workflows. Rename.
- **`taskQueue`** may not have leading/trailing whitespace or exceed 1000
  characters.
- **`onRehydrationMiss` is removed** from `@temporal-contract/contract/errors` —
  its module-level handler never fired inside the bundled workflow sandbox.
  Delete the registration: the worker logs each miss through the workflow
  logger (`log.warn`), and the client takes a hook in
  `TypedClient.create({ client, onRehydrationMiss })`. The `RehydrationMiss`
  type stays exported.
- **`IdempotencyMode` is removed** — use `WorkflowStartPolicy`.

### Client

- **`getHandle` returns the handle directly**, like Temporal's:
  `orders.getHandle(name, id).getOrThrow()` → `orders.getHandle(name, id)`.
- **`WorkflowNotInContractError` is removed** — its class, its
  `WORKFLOW_NOT_IN_CONTRACT_ERROR_TAG`, and its slot in every union and in
  `WORKFLOW_START_PATTERNS` / `WORKFLOW_EXECUTE_PATTERNS` /
  `SCHEDULE_CREATE_PATTERNS`. The types only admit declared names, so an
  undeclared workflow, signal, or update name is a defect carrying a
  `TechnicalError`. Delete the `P.tag(...)` arms.
- **The contract owns the start options.** `workflowIdReusePolicy` and
  `followRuns` are no longer accepted by `startWorkflow` / `signalWithStart` /
  `executeWorkflow` (nor `followRuns` by `getHandle`): the contract's
  `startPolicy` always wins, and handles always follow the run chain.
  `signalWithStart` enforces `workflowId` like `startWorkflow` — forbidden
  when the contract derives it, required otherwise.
- **Start handles' `runId` is `undefined`** — they follow the run chain. Read
  `firstExecutionRunId` for the started run.
- **`executeWorkflow` is `startWorkflow(...)` then `handle.result()`**, so its
  result-phase errors name the derived workflow ID, and an unrecognized result
  failure's `RuntimeClientError.operation` is `"result"`.
- **Update errors match the SDK.** `startUpdate` errs only with
  `UpdateValidationError | UpdateRpcTimeoutOrCancelledError | WorkflowExecutionNotFoundError`;
  a rejection or a failed handler surfaces on the update handle's `result()`.
  The new `UpdateRpcTimeoutOrCancelledError` joins every update union and
  `UPDATE_PATTERNS` — add an arm.
- **Temporal's `QueryRejectedError`** (a query refused because of the
  execution's status) surfaces as `QueryFailedError`.
- **Search-attribute values are checked against their declared kind** at
  runtime again (a defect, like an undeclared key). `schedule.update` re-checks
  the action's search attributes and refuses to move a contract workflow off
  the contract's task queue.
- **Schedules:** `schedule.create`'s `args` is optional when the input schema
  accepts `undefined`; `TypedScheduleHandle.raw` exposes the SDK handle.
- **New:** `handle.updates.name(input, { updateId })`,
  `handle.getUpdateHandle(updateName, updateId)`,
  `contractClient.executeUpdateWithStart(...)`,
  `contractClient.workflowIdFor(workflowName, input)`,
  `WorkflowFailedError.retryState`, and the re-exported `CONTRACT_ERROR_TAG` /
  `RehydrationMiss`.
- **Peers:** install `@temporal-contract/contract@beta` alongside the client;
  `@temporalio/client` / `@temporalio/common` `^1.24.0`, `unthrown` `^5.11.0`.

### Worker

- **Library errors thrown from workflow code fail the workflow.**
  `throw result.error` / `.getOrThrow()` on an `ActivityError`, `ChildWorkflowError`,
  `*CancelledError`, or `ChildWorkflowNotFoundError` used to retry the
  workflow task forever; `declareWorkflow` and signal/update handlers now map
  them to the Temporal failure they carry, the same mapping as
  `propagateFailure`. A thrown update-handler error rejects the update.
- **`context.info` is live** — a getter over `workflowInfo()`, so
  `continueAsNewSuggested` / `historyLength` update between activations.
- **Child workflows follow the contract.** A child whose definition declares
  `workflowId` derives it from `args`, and `options.workflowId` is a type
  error — drop it. The child's declared errors rehydrate into typed
  `ContractError`s on `executeChildWorkflow` / `handle.result()` (new
  `ChildWorkflowContractErrorsOf`), and `context.saga` compensates on them —
  handle the new members on the error channel.
- **No per-call `workflowIdReusePolicy` on child workflows** — change the
  child's `startPolicy` instead.
- **`ContractMisuseError` for structural misuse**: an undeclared
  `ContractError` name (was `ContractErrorDataValidationError` with a fake
  issue), a `continueAsNew` target not on the contract (was
  `WorkflowInputValidationError`), and `declareActivitiesHandler`'s missing,
  conflicting, or ambiguous implementations (were plain `Error`). Also
  exported from `./activity`. Match on `ContractMisuseError` /
  `type === "ContractMisuseError"`.
- **`TypedWorker.create` fails on a misdeclared workflows module** — a
  `ContractMisuseError` thrown by `declareWorkflow` at import is a
  `TechnicalError` defect instead of being skipped.
- **`TypedWorker.shutdown()` returns `Result<void, never>`** — calling it on a
  worker that is not running is a defect, not a throw. Use
  `worker.shutdown().get()` to keep throwing.
- **Validation failures carry their issues in `details[0]`** (`{ message, path }`,
  encrypted by payload codecs) now that `message` lists paths only.
- **No bind-time sync-schema probe.** An async query/update input schema is
  rejected on the first query/update, not when the handler is bound.
- **`qualifyFailure` never wraps a cancellation** (`CancelledFailure`,
  `AbortError`), even with `expected: "any"` — it rides the defect channel and
  stays a cancellation.
- **`rethrowCancellation` / `propagateFailure`** throw a fresh
  `CancelledFailure` for a cancellation error with no `cause`.
- **Scope typing.** `cancellableScope` / `nonCancellableScope` resolve to
  `Awaited<T>`: a returned `AsyncResult` is adopted, so the scope's value is
  its settled `Result`.
- **Peers:** install `@temporal-contract/contract@beta` alongside the worker;
  `@temporalio/*` `^1.24.0`, `unthrown` `^5.11.0`.

### Testing

- **`createContractTest` runs each call (each test file, in practice) in its
  own Temporal namespace**, registered on the testcontainers server and used
  by the worker and the clients, so parallel files no longer steal each
  other's tasks. The new `namespace` fixture names it; a
  `workerOptions.namespace` replaces it and must already exist. The workflows
  are bundled once per file, and `workerOptions` no longer accepts
  `workflowBundle` — drop it.
- **`testRig` / `createTimeSkippingContractTest`** replay workflows whose
  contract derives the workflow ID (resolved with `workflowIdFor`) and record
  `executeUpdateWithStart` starts.
- **Teardown waits for the worker to stop from any state** (`STOPPING` /
  `DRAINING` / `DRAINED` included), with a timeout, and checks
  `TypedWorker.shutdown()`'s result.
- **`runActivityHandler` round-trips the input, the output, and the failure
  details through the payload converter** (`defaultPayloadConverter`, or the
  new `payloadConverter` option). A value that does not survive serialization
  — a `Date` under the JSON converter — now fails with
  `ActivityOutputValidationError`, as in production. An undeclared error name
  surfaces `ContractMisuseError`.
- **`RunActivityImplementation`'s helpers are the worker's
  `ActivityImplementationHelpers`**, so `idempotencyKey` can be destructured.
- **Global setup:** a container that fails to start stops the ones already
  started; health checks retry 60 times by default (`healthCheckRetries`);
  the default images are pinned by digest; PostgreSQL gets a random password
  per run and no host port; the Temporal health check uses the `temporal` CLI
  instead of `tctl`.
- **Internal helpers left the public entries:** `resolveTemporalAddress`
  (`/extension`) and `isTerminalStatus`, `START_METHODS`, `skipReasonFor`,
  `extractStartedWorkflowId` (`/test-rig`). Copy them if you relied on them.
- **Peers:** `@temporalio/*` `^1.24.0`, `unthrown` `^5.11.0`; `vitest` and
  `@temporalio/testing` are now optional — `/activity` and `/workflow-bundle`
  need no `vitest`, and only `/activity`, `/time-skipping`, and `/test-rig`
  need `@temporalio/testing`.
