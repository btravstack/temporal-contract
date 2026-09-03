# Sample coverage

What temporal-contract can express, measured against
[temporalio/samples-typescript](https://github.com/temporalio/samples-typescript)
— the closest thing the ecosystem has to a capability checklist.

| Status | Meaning                                                                                                             |
| ------ | ------------------------------------------------------------------------------------------------------------------- |
| ✅     | Supported, **and a test proves it**. The test is linked; a doc page is not enough for a ✅.                         |
| ⚠️     | Supported, but nothing in this repo tests it end to end. Believe it less than a ✅.                                 |
| ❌     | Not supported today.                                                                                                |
| ➖     | Not applicable — the sample is about app framework, deployment, or an AI SDK, not about what a contract layer does. |

Tests live in `packages/*/src/__tests__/`. Anything named `*.inprocess.spec.ts`
runs against a real time-skipping Temporal server; `*.spec.ts` at the package
root is a unit test.

## Core workflow and activity mechanics

| Sample                                                                                                                                                                    | Status | How, and what proves it                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [hello-world](https://github.com/temporalio/samples-typescript/tree/main/hello-world)                                                                                     | ✅     | `defineContract` + `declareWorkflow` + `declareActivitiesHandler`. `packages/worker/src/__tests__/one-call-fixture.inprocess.spec.ts`                                                                                     |
| [activities-examples](https://github.com/temporalio/samples-typescript/tree/main/activities-examples)                                                                     | ✅     | Activities return `AsyncResult`; failures are `ApplicationFailure` via `qualifyFailure`. `packages/worker/src/activity.spec.ts`                                                                                           |
| [activities-dependency-injection](https://github.com/temporalio/samples-typescript/tree/main/activities-dependency-injection)                                             | ✅     | `createContext` + activity middleware inject dependencies per invocation instead of module state. `packages/worker/src/__tests__/time-skipping.inprocess.spec.ts`, `packages/worker/src/activity-contract-errors.spec.ts` |
| [activities-cancellation-heartbeating](https://github.com/temporalio/samples-typescript/tree/main/activities-cancellation-heartbeating)                                   | ✅     | Cancellation arrives as `ActivityCancelledError` on the modeled channel; `rethrowCancellation` re-raises it. `packages/worker/src/__tests__/cancellation.inprocess.spec.ts`                                               |
| [timer-examples](https://github.com/temporalio/samples-typescript/tree/main/timer-examples)                                                                               | ✅     | `sleep` / `condition` from `@temporalio/workflow` inside `implementation`. `packages/worker/src/__tests__/timeouts.inprocess.spec.ts`                                                                                     |
| [child-workflows](https://github.com/temporalio/samples-typescript/tree/main/child-workflows)                                                                             | ✅     | `context.executeChildWorkflow` / `startChildWorkflow`, typed against the child's contract. `packages/worker/src/__tests__/child-wire.inprocess.spec.ts`                                                                   |
| [continue-as-new](https://github.com/temporalio/samples-typescript/tree/main/continue-as-new)                                                                             | ✅     | `context.continueAsNew`, with the run chain replayed in full. `packages/worker/src/__tests__/continue-as-new.inprocess.spec.ts`                                                                                           |
| [saga](https://github.com/temporalio/samples-typescript/tree/main/saga)                                                                                                   | ✅     | `context.saga()` — LIFO undos, machinery failures exempt, undos in a non-cancellable scope. `packages/worker/src/__tests__/saga.inprocess.spec.ts`                                                                        |
| [patching-api](https://github.com/temporalio/samples-typescript/tree/main/patching-api)                                                                                   | ⚠️     | `patched`/`deprecatePatch` from `@temporalio/workflow` work inside `implementation`; the contract layer neither helps nor hinders. No test here.                                                                          |
| [worker-specific-task-queues](https://github.com/temporalio/samples-typescript/tree/main/worker-specific-task-queues)                                                     | ✅     | Per-activity `taskQueue` overrides. `packages/worker/src/__tests__/routing.spec.ts`                                                                                                                                       |
| [mutex](https://github.com/temporalio/samples-typescript/tree/main/mutex)                                                                                                 | ⚠️     | Expressible with signals + `condition` (the sample's own approach). No test here.                                                                                                                                         |
| [batch-sliding-window](https://github.com/temporalio/samples-typescript/tree/main/batch-sliding-window)                                                                   | ⚠️     | Expressible with child workflows + continue-as-new, both tested individually; the composition is not.                                                                                                                     |
| [dsl-interpreter](https://github.com/temporalio/samples-typescript/tree/main/dsl-interpreter)                                                                             | ⚠️     | A DSL workflow takes its program as validated input like any other payload. No test here.                                                                                                                                 |
| [expense](https://github.com/temporalio/samples-typescript/tree/main/expense) / [food-delivery](https://github.com/temporalio/samples-typescript/tree/main/food-delivery) | ✅     | Human-in-the-loop: signal-driven approval gate. `examples/order-processing-worker` (`processOrder`), `src/integration.spec.ts`                                                                                            |

## Messages: signals, queries, updates

| Sample                                                                                                | Status | How, and what proves it                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [signals-queries](https://github.com/temporalio/samples-typescript/tree/main/signals-queries)         | ✅     | `defineSignal` / `defineQuery` + `context.handleSignal` / `handleQuery`, validated both sides. `packages/worker/src/__tests__/handlers.inprocess.spec.ts` |
| [message-passing](https://github.com/temporalio/samples-typescript/tree/main/message-passing)         | ✅     | Updates too: `defineUpdate` + `context.handleUpdate`, with worker-side admission rejection typed as `UpdateRejectedError`. Same file.                     |
| [query-subscriptions](https://github.com/temporalio/samples-typescript/tree/main/query-subscriptions) | ⚠️     | Polling a typed query from the client works; the sample's streaming shape is app code.                                                                    |
| [early-return](https://github.com/temporalio/samples-typescript/tree/main/early-return)               | ⚠️     | Expressible with `startUpdate` + a later `result()`. No test here.                                                                                        |
| [state](https://github.com/temporalio/samples-typescript/tree/main/state)                             | ✅     | Workflow-local state read by a query. `packages/worker/src/__tests__/handlers.inprocess.spec.ts`                                                          |

## Client, scheduling, and indexing

| Sample                                                                                                  | Status | How, and what proves it                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [schedules](https://github.com/temporalio/samples-typescript/tree/main/schedules)                       | ⚠️     | `client.schedule.create/getHandle/trigger`, typed against the contract, with `ScheduleAlreadyExistsError` modeled. Unit-tested against a stubbed client (`packages/client/src/schedule.spec.ts`); **no real-server test**.                      |
| [cron-workflows](https://github.com/temporalio/samples-typescript/tree/main/cron-workflows)             | ➖     | Deprecated upstream in favour of schedules.                                                                                                                                                                                                     |
| [search-attributes](https://github.com/temporalio/samples-typescript/tree/main/search-attributes)       | ⚠️     | `defineSearchAttribute` + typed `searchAttributes` on start, `readTypedSearchAttributes` on read. Unit-tested (`packages/client/src/client.spec.ts`); **no real-server test** — and visibility is exactly what a real server tests differently. |
| [eager-workflow-start](https://github.com/temporalio/samples-typescript/tree/main/eager-workflow-start) | ⚠️     | A per-call Temporal option; passes through the typed start options untouched.                                                                                                                                                                   |
| [standalone-activity](https://github.com/temporalio/samples-typescript/tree/main/standalone-activity)   | ❌     | No client-side standalone activity execution.                                                                                                                                                                                                   |
| [workflow-streams](https://github.com/temporalio/samples-typescript/tree/main/workflow-streams)         | ⚠️     | Built on updates/queries, which are typed; the streaming wrapper is app code.                                                                                                                                                                   |

## Failure handling and retries

| Sample                                                                                      | Status | How, and what proves it                                                                                                                                                                |
| ------------------------------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [polling](https://github.com/temporalio/samples-typescript/tree/main/polling)               | ✅     | Retry policies per activity via `activityOptions` / `activityOptionsByName`. `packages/worker/src/__tests__/retry.inprocess.spec.ts`                                                   |
| [timer-progress](https://github.com/temporalio/samples-typescript/tree/main/timer-progress) | ✅     | Heartbeats and timeouts. `packages/worker/src/__tests__/timeouts.inprocess.spec.ts`                                                                                                    |
| [sleep-for-days](https://github.com/temporalio/samples-typescript/tree/main/sleep-for-days) | ✅     | Long durable timers, time-skipped in tests. `packages/worker/src/__tests__/time-skipping.inprocess.spec.ts`                                                                            |
| Typed domain errors (no upstream equivalent)                                                | ✅     | `errors:` on an activity or workflow crosses the wire as `ApplicationFailure` and rehydrates as a typed `ContractError`. `packages/worker/src/__tests__/rehydration.inprocess.spec.ts` |

## Nexus

| Sample                                                                                                                | Status | Notes                                                                      |
| --------------------------------------------------------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------- |
| [nexus-hello](https://github.com/temporalio/samples-typescript/tree/main/nexus-hello)                                 | ❌     | No Nexus support, and no target release — see `docs/explanation/nexus.md`. |
| [nexus-cancellation](https://github.com/temporalio/samples-typescript/tree/main/nexus-cancellation)                   | ❌     | Same.                                                                      |
| [nexus-messaging](https://github.com/temporalio/samples-typescript/tree/main/nexus-messaging)                         | ❌     | Same.                                                                      |
| [nexus-standalone-operations](https://github.com/temporalio/samples-typescript/tree/main/nexus-standalone-operations) | ❌     | Same.                                                                      |

## Operations and worker configuration

| Sample                                                                                                                                                                                                                                                                      | Status | Notes                                                                                                                                        |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| [custom-logger](https://github.com/temporalio/samples-typescript/tree/main/custom-logger)                                                                                                                                                                                   | ⚠️     | Worker options pass through `TypedWorker.create`; `log.*` from `@temporalio/workflow` is the workflow-side path.                             |
| [sinks](https://github.com/temporalio/samples-typescript/tree/main/sinks)                                                                                                                                                                                                   | ⚠️     | Passes through worker options untouched. No test here.                                                                                       |
| [interceptors-opentelemetry](https://github.com/temporalio/samples-typescript/tree/main/interceptors-opentelemetry)                                                                                                                                                         | ⚠️     | Temporal interceptors pass through; activity **middleware** is the contract-aware equivalent for the activity side.                          |
| [encryption](https://github.com/temporalio/samples-typescript/tree/main/encryption) / [protobufs](https://github.com/temporalio/samples-typescript/tree/main/protobufs) / [ejson](https://github.com/temporalio/samples-typescript/tree/main/ejson)                         | ⚠️     | A custom data converter is a worker/client option. Note the contract validates the **decoded** payload, so a converter and a schema compose. |
| [worker-versioning](https://github.com/temporalio/samples-typescript/tree/main/worker-versioning)                                                                                                                                                                           | ⚠️     | Build IDs are worker options; nothing contract-specific.                                                                                     |
| [hello-world-mtls](https://github.com/temporalio/samples-typescript/tree/main/hello-world-mtls) / [env-config](https://github.com/temporalio/samples-typescript/tree/main/env-config) / [grpc-calls](https://github.com/temporalio/samples-typescript/tree/main/grpc-calls) | ➖     | Connection concerns — you build the `Client`/`NativeConnection`, we wrap it.                                                                 |
| [production](https://github.com/temporalio/samples-typescript/tree/main/production)                                                                                                                                                                                         | ➖     | Deployment shape.                                                                                                                            |

## Not applicable

App-framework and AI-SDK samples, which say nothing about a contract layer:
[nestjs-exchange-rates](https://github.com/temporalio/samples-typescript/tree/main/nestjs-exchange-rates),
[nextjs-ecommerce-oneclick](https://github.com/temporalio/samples-typescript/tree/main/nextjs-ecommerce-oneclick),
[lambda-worker](https://github.com/temporalio/samples-typescript/tree/main/lambda-worker),
[monorepo-folders](https://github.com/temporalio/samples-typescript/tree/main/monorepo-folders),
[fetch-esm](https://github.com/temporalio/samples-typescript/tree/main/fetch-esm),
[vscode-debugger](https://github.com/temporalio/samples-typescript/tree/main/vscode-debugger),
[hello-world-js](https://github.com/temporalio/samples-typescript/tree/main/hello-world-js) (JavaScript, so no types to check),
and the agent samples
([ai-sdk](https://github.com/temporalio/samples-typescript/tree/main/ai-sdk),
[openai-agents](https://github.com/temporalio/samples-typescript/tree/main/openai-agents),
[google-adk-agents](https://github.com/temporalio/samples-typescript/tree/main/google-adk-agents),
[strands-agents](https://github.com/temporalio/samples-typescript/tree/main/strands-agents),
[langsmith](https://github.com/temporalio/samples-typescript/tree/main/langsmith)).

## What this table says about the gaps

- **Nexus is the one flat no.** Four samples, no support, no target release.
- **Schedules and search attributes are the weakest ✅-adjacent entries**: both
  have a typed surface and unit tests against a stubbed client, and neither has
  a real-server test — which is precisely the tier those two features need,
  since visibility and schedule semantics are what a real cluster does
  differently.
- Most ⚠️ rows are "Temporal's own API passes through untouched". That is
  usually the right answer for a contract layer, but it is a claim this repo
  does not currently test.
