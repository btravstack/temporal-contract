# Testing surface

`@temporal-contract/testing` has seven entry points and no root export — each
tier is importable on its own so a Docker-free unit test never pulls in the
testcontainers stack.

| Entry point                                  | Tier                                               |
| -------------------------------------------- | -------------------------------------------------- |
| `@temporal-contract/testing/activity`        | Docker-free single-activity unit tests             |
| `@temporal-contract/testing/time-skipping`   | In-process time-skipping `TestWorkflowEnvironment` |
| `@temporal-contract/testing/contract`        | Full stack over a testcontainers Temporal server   |
| `@temporal-contract/testing/extension`       | Raw connection fixtures (client + worker)          |
| `@temporal-contract/testing/global-setup`    | Vitest `globalSetup` that boots the test server    |
| `@temporal-contract/testing/test-rig`        | Worker + client pair with replay-on-finish         |
| `@temporal-contract/testing/workflow-bundle` | Bundle cache and task-queue / fixture-path helpers |

Generated per-symbol docs: [API reference](/api/testing/).

::: tip House assertion style
All examples use the [`@unthrown/vitest`](https://github.com/btravstack/unthrown)
matchers — `toBeOk`, `toBeOkWith`, `toBeErr`, `toBeErrTagged`, `toBeDefect` —
over `expect(r.isOk()).toBe(true)`. They read the `Result` channel directly and
give better failure messages. Register them once in a Vitest setup file.
:::

## `@temporal-contract/testing/activity`

Two altitudes for testing one activity implementation — the
`(helpers, args) => AsyncResult<...>` function you pass to
`declareActivitiesHandler` — inside `@temporalio/testing`'s
`MockActivityEnvironment`. No worker, server, or Docker.

### `runActivity(definition, options)`

```typescript
function runActivity<TActivity, TOutput, TError>(
  definition: TActivity, // e.g. contract.workflows.processOrder.activities.chargeCard
  options: {
    implementation: (helpers, args) => AsyncResult<TOutput, TError>;
    input: WorkerInferInput<TActivity>; // the parsed shape the worker hands the impl
    env?: MockActivityEnvironment; // reuse one to observe heartbeats / cancel
  },
): AsyncResult<TOutput, TError>;
```

The **pure-logic** tier: the implementation's `AsyncResult` flows through
**untouched** — no input parse, no output validation, no contract-error wire
conversion. `Ok`/`Err` pass as-is; an unanticipated throw (including a
`CancelledFailure`) lands on the `defect` channel. The typed `errors`
constructors are built from `definition.errors` and handed to the
implementation; `context` is always empty here (exercise middleware-injected
context through a real worker).

```typescript
import { runActivity } from "@temporal-contract/testing/activity";

const result = await runActivity(orderContract.workflows.processOrder.activities.chargeCard, {
  implementation: chargeCard,
  input: { amount: 100 },
});

await expect(result).toBeOk();
```

Pass a prepared `MockActivityEnvironment` via `env` to observe heartbeats
(`env.on("heartbeat", ...)`), trigger cancellation (`env.cancel()`), or
customize the activity info.

### `runActivityHandler(definition, options)`

```typescript
function runActivityHandler<TActivity, TOutput, TError>(
  definition: TActivity,
  options: {
    implementation: (helpers, args) => AsyncResult<TOutput, TError>;
    input: ClientInferInput<TActivity>; // the WIRE value, as a caller sends it
    activityName?: string; // diagnostic name in validation errors (default "activity")
    env?: MockActivityEnvironment;
    payloadConverter?: Pick<PayloadConverter, "toPayload" | "fromPayload">; // default: defaultPayloadConverter
  },
): AsyncResult<ClientInferOutput<TActivity>, RunActivityHandlerError<TActivity>>;
```

The **boundary-faithful** tier: routes the same implementation through the
**real** `declareActivitiesHandler` wrapping and classifies the outcome the way
a workflow-side caller would —

- the wire input is parsed against the contract's input schema (an invalid
  input surfaces the production `ActivityInputValidationError`);
- the input, the output, and the failure details round-trip through the
  payload converter (`defaultPayloadConverter`, or the `payloadConverter` you
  pass — use the one your worker and client are configured with), so a value
  that does not survive serialization fails as it would in production — a
  `Date` output becomes a string under the JSON converter and surfaces
  `ActivityOutputValidationError`;
- an `Ok` output is validated on send and parsed on receive, so a transforming
  output schema applies exactly once, and drift surfaces
  `ActivityOutputValidationError`;
- a typed `Err(errors.X(data))` is converted to its `ApplicationFailure` wire
  shape (`type` = error name, `details[0]` = data, `details[1]` = the wire
  marker) and **rehydrated** back into the typed `ContractError` — the full
  round-trip;
- contract misuse surfaces the production failure: an undeclared error name
  as `ContractMisuseError`, error data failing its schema as
  `ContractErrorDataValidationError`;
- an unanticipated throw stays on the `defect` channel.

`RunActivityHandlerError<TActivity>` is the activity's declared errors
(rehydrated, post-transform) plus `ApplicationFailure` for everything else that
crossed the boundary.

```typescript
import { runActivityHandler } from "@temporal-contract/testing/activity";

const result = await runActivityHandler(
  orderContract.workflows.processOrder.activities.chargeCard,
  {
    implementation: chargeCard,
    input: { amount: -1 },
  },
);

await expect(result).toBeErrTagged("@temporal-contract/ContractError");
```

Use `runActivity` for pure logic; reach for `runActivityHandler` when the test
should fail exactly where production fails. `RunActivityImplementation`,
`RunActivityOptions`, `RunActivityHandlerOptions`, and `RunActivityHandlerError`
are exported.

## `@temporal-contract/testing/time-skipping`

In-process, Docker-free workflow tests via Temporal's time-skipping
`TestWorkflowEnvironment` — a lightweight local binary (downloaded and cached
by `@temporalio/testing` on first use) that fast-forwards timers, so full
contract/handler tests run in seconds without a cluster.

### `it`

A ready-made Vitest `it` with a worker-scoped `testEnv` fixture (one
environment per Vitest worker process, torn down on exit).

```typescript
import { it } from "@temporal-contract/testing/time-skipping";
import { fixturePath } from "@temporal-contract/testing/workflow-bundle";
import { TypedWorker } from "@temporal-contract/worker/worker";
import { TypedClient } from "@temporal-contract/client";

it("processes the order", async ({ testEnv }) => {
  const worker = await TypedWorker.create({
    contract: myContract,
    connection: testEnv.nativeConnection,
    workflowsPath: fixturePath(import.meta.url, "test.workflows"), // .ts under Vitest
    activities,
  }).get();
  const client = (await TypedClient.create({ client: testEnv.client }).get()).for(myContract);

  await worker.raw.runUntil(async () => {
    const result = await client.executeWorkflow("processOrder", {
      workflowId: "order-1",
      args: { orderId: "ORD-1" },
    });
    expect(result).toBeOk();
  });
});
```

### `createTimeSkippingTest(options?)`

Build the same `it` with pinned environment options (e.g. a specific test-server
version) — options are forwarded to `TestWorkflowEnvironment.createTimeSkipping`
unchanged.

### `createTimeSkippingEnvironment(options?)`

Create a `TestWorkflowEnvironment` directly for suites that prefer explicit
`beforeAll`/`afterAll` management (remember `env.teardown()`).

### `createTimeSkippingContractTest(options)`

```typescript
function createTimeSkippingContractTest<TContract>(options: {
  contract: TContract;
  workflowsPath: string;
  activities?: ActivitiesHandler<TContract>;
  replaySkipAllowlist?: Readonly<Record<string, string>>; // forwarded to testRig
  environment?: TimeSkippingTestWorkflowEnvironmentOptions;
}): TestFunction;
```

The one-call fixture for this tier: `testEnv`, a `bundle` (built once per
Vitest worker process), and a per-test `worker` and contract-bound `client`
built by [`testRig`](#temporal-contract-testing-test-rig) — so every execution
the test starts is replayed when it finishes. The worker is created, not
started: run your calls inside `worker.raw.runUntil(...)`. Teardown waits for
the worker to stop from whatever state the test left it in. Like `testRig`, it
does not scope the task queue.

## `@temporal-contract/testing/contract`

The full integration stack for one contract over the testcontainers-provided
Temporal server: a running worker on the contract's task queue, the
connection-scoped `TypedClient` root, and the contract-bound `ContractClient`.

### `createContractTest(options)`

```typescript
function createContractTest<TContract>(options: {
  contract: TContract; // its taskQueue names the worker's queue
  workflowsPath: string; // e.g. fixturePath(import.meta.url, "x.workflows")
  activities?: ActivitiesHandler<TContract>; // omit for a workflow-only worker
  workerOptions?: Omit<
    CreateWorkerOptions<TContract>,
    "activities" | "connection" | "contract" | "workflowBundle" | "workflowsPath"
  >;
}): TestFunction; // a Vitest `it` with contract fixtures
```

Returns a Vitest `it` whose fixtures expose:

| Fixture       | Type                                                                                                      |
| ------------- | --------------------------------------------------------------------------------------------------------- |
| `namespace`   | `string` — the Temporal namespace the worker and clients use                                              |
| `client`      | `ContractClient<TContract>`                                                                               |
| `typedClient` | `TypedClient` (the root)                                                                                  |
| `worker`      | `TypedWorker` (started `auto` before the test, shut down after; `worker.raw` for the underlying `Worker`) |

The connection fixtures from `/extension` (`clientConnection`,
`workerConnection`) remain on the context.

**One namespace per call.** Test files run in parallel against one server, and
each worker polls the contract's real task queue — in a shared namespace, one
file's worker would pick up another file's tasks. So every `createContractTest`
call (in practice, every test file) registers its own `contract-test-<uuid>`
namespace and points both the worker and the clients at it. A
`workerOptions.namespace` replaces it; that namespace must already exist on the
server. The workflows are bundled once per test file and passed to the worker
as `workflowBundle`, which is why `workerOptions` no longer accepts one.

```typescript
import { createContractTest } from "@temporal-contract/testing/contract";
import { declareActivitiesHandler } from "@temporal-contract/worker/activity";
import { fixturePath } from "@temporal-contract/testing/workflow-bundle";
import { describe, expect } from "vitest";

import { orderContract } from "./order.contract.js";

const activities = declareActivitiesHandler({ contract: orderContract, activities: {/* ... */} });

const it = createContractTest({
  contract: orderContract,
  workflowsPath: fixturePath(import.meta.url, "order.workflows"),
  activities,
});

describe("order processing", () => {
  it("processes an order end-to-end", async ({ client }) => {
    const result = await client.executeWorkflow("processOrder", {
      workflowId: `order-${Date.now()}`,
      args: { orderId: "ORD-1" },
    });
    await expect(result).toBeOk();
  });
});
```

`CreateContractTestOptions` and `ContractTestContext` are exported.

::: warning Requires the global setup
`createContractTest` needs the `@temporal-contract/testing/global-setup` global
setup registered on the test project (below), which is what boots the
testcontainers Temporal server it connects to.
:::

## `@temporal-contract/testing/global-setup`

### default export — `createGlobalSetup()`

A Vitest `globalSetup` that starts a Temporal server (PostgreSQL +
`temporalio/auto-setup`) via testcontainers and provides its address to the
`/extension` and `/contract` fixtures. PostgreSQL gets a random password per
run and no host port — it is reachable only from the Temporal container on a
private network. The Temporal health check runs the `temporal` CLI inside the
container. If a container fails to start, the ones already started are stopped
before the error surfaces. Register it directly:

```typescript
// vitest.config.ts
export default defineConfig({
  test: { globalSetup: "@temporal-contract/testing/global-setup" },
});
```

### `createGlobalSetup(options?)`

Build a configured setup — reference this factory from your own global-setup
module to pin images, inject Temporal env, or silence progress logs.
`CreateGlobalSetupOptions`:

| Field                | Type                     | Default                                             |
| -------------------- | ------------------------ | --------------------------------------------------- |
| `postgresImage`      | `string`                 | `"postgres:18.1@sha256:…"` (pinned by digest)       |
| `temporalImage`      | `string`                 | `"temporalio/auto-setup:1.29.1@sha256:…"` (digest)  |
| `healthCheckRetries` | `number`                 | `60` — failed checks (one per second) per container |
| `temporalEnv`        | `Record<string, string>` | `{}` (merged over the defaults)                     |
| `quiet`              | `boolean`                | `false`                                             |

Raise `healthCheckRetries` on slow CI runners or when the images still have to
be pulled.

```typescript
// temporal-global-setup.ts
import { createGlobalSetup } from "@temporal-contract/testing/global-setup";

export default createGlobalSetup({ temporalImage: "temporalio/auto-setup:1.28.0", quiet: true });
```

## `@temporal-contract/testing/extension`

A Vitest `it` extended with two raw connection fixtures backed by the
global-setup server: `clientConnection` (`@temporalio/client` `Connection`) and
`workerConnection` (`@temporalio/worker` `NativeConnection`). Use it when you
need connections but want to wire the client/worker yourself; `/contract` builds
on top of it. These connections use the server's `default` namespace, so tests
wiring their own worker should isolate it with a per-test task queue
(`withTaskQueue` / `nextTaskQueueId` from `/workflow-bundle`). `it` is the
entry's only export.

## `@temporal-contract/testing/test-rig`

### `testRig(testEnv, options)`

```typescript
function testRig<TContract>(
  testEnv: TestWorkflowEnvironment,
  options: {
    contract: TContract;
    bundle: WorkflowBundleWithSourceMap; // e.g. from bundleFor(...)
    activities?: ActivitiesHandler<TContract>;
    replaySkipAllowlist?: Readonly<Record<string, string>>; // ID prefix → reason
  },
): Promise<{ worker: TypedWorker; client: ContractClient<TContract> }>;
```

The lower-level seam under `createTimeSkippingContractTest`: builds the worker
and the contract-bound client, records the workflow ID of every
`startWorkflow` / `executeWorkflow` / `signalWithStart` /
`executeUpdateWithStart` call — resolving it with `workflowIdFor` when the
contract derives it — and, when the test finishes, replays each recorded
execution's full run chain against the bundle. An execution left non-terminal
fails the test unless its ID matches a `replaySkipAllowlist` prefix (longest
wins), each with a reason. `testRig` is the entry's only export.

## `@temporal-contract/testing/workflow-bundle`

Helpers for suites that build workers themselves. Needs neither `vitest` nor
`@temporalio/testing`.

| Export                            | Does                                                                                            |
| --------------------------------- | ----------------------------------------------------------------------------------------------- |
| `bundleFor(workflowsPath)`        | Bundles once per test file (the promise is cached by path); pass it as `workflowBundle`         |
| `withTaskQueue(contract, id)`     | Shallow copy of the contract on another task queue — per-test isolation                         |
| `nextTaskQueueId(prefix)`         | Monotonic `prefix-N` IDs (a counter, so failing runs reproduce)                                 |
| `fixturePath(import.meta.url, f)` | Path to sibling file `f` with the caller's own extension — `.ts` under Vitest, `.js` when built |

## Peer dependencies

The three sibling `@temporal-contract/*` packages, `@temporalio/client` and
`@temporalio/worker` (`^1.24.0`), and `unthrown` (`^5.11.0`) are required.
Three peers are **optional**, needed only by some entries:

| Optional peer         | Needed by                                                     |
| --------------------- | ------------------------------------------------------------- |
| `vitest`              | every entry except `/activity` and `/workflow-bundle`         |
| `@temporalio/testing` | `/activity`, `/time-skipping`, `/test-rig`                    |
| `testcontainers`      | `/global-setup` (and so `createContractTest`, which needs it) |

When `testcontainers` is missing, `/global-setup` fails with a descriptive
install hint (`pnpm add -D testcontainers`).

## Next

- [Test workflows](/how-to/test-workflows)
- [Worker surface](/reference/worker-surface)
- [Client surface](/reference/client-surface)
