# Determinism and Money-Safety Invariants Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove by effect the invariants the library could silently break — retry terminality, timeout forwarding, and replay determinism across every sandboxed construct.

**Architecture:** A `testRig` helper replaces the worker+client construction already present in every in-process test. Its client records started workflow IDs; an `onTestFinished` hook fetches each execution's history and replays it against the bundle the worker was built from. Replay coverage therefore becomes automatic for present and future tests. Retry and timeout invariants are proven by reading what Temporal actually materialized, not by reading fields off the wire.

**Tech Stack:** TypeScript (ESM), Vitest 4.1.10, `@temporalio/worker` 1.20.3, `@temporalio/activity`, unthrown 5.

## Global Constraints

Copied from `CLAUDE.md` and the spec. Every task's requirements implicitly include this section.

- **Workflow code is deterministic.** No `Date.now()`, `Math.random()`, `setTimeout`, `crypto.randomUUID()`, native I/O, or `process.env` inside `declareWorkflow`'s `implementation`. Activities are not sandboxed and may use them.
- **`.js` extensions in every relative import.** ESM only. No CommonJS.
- **No `any`.** Use `unknown` and narrow. Enforced by oxlint.
- **Catalog versions.** New dependency versions go in `pnpm-workspace.yaml`'s `catalog:` block; per-package entries use `"catalog:"`.
- **Activities return `AsyncResult<T, E>`** — `OkAsync` / `ErrAsync`, narrowed with `.isOk()` / `.isErr()` / `.isDefect()`.
- **Assert effects, never call shapes.** Specific outcomes with `toBe` / `toEqual`, never a substring any failure would satisfy. Any assert-empty needs a positive control.
- **A regression must fail an assertion, not hang** to the 120s timeout. Pass `workflowExecutionTimeout: "30 seconds"` in start option bags; fold failure detail into returned status strings rather than rethrowing.
- **Bound activity retries explicitly** (`retry: { maximumAttempts: 1 }`) unless the test is specifically about retry.
- **A real `DeterminismViolationError` is a finding, not an obstacle.** If replay surfaces one in shipped code, STOP and report it. Do not adjust the test to pass.

## Key API Facts (verified against the installed SDK — do not re-derive)

- `Worker.runReplayHistory(options: ReplayWorkerOptions, history: History | unknown, workflowId?: string): Promise<void>` — from `@temporalio/worker`. `ReplayWorkerOptions` is `Omit<WorkerOptions, 'connection'|'namespace'|'taskQueue'|'activities'|…>`, so **`workflowBundle` and `workflowsPath` both pass through**. It needs no server.
- History is fetched with `testEnv.client.workflow.getHandle(workflowId).fetchHistory()`.
- `handle.describe()` returns `{ status: { name: WorkflowExecutionStatusName } }` where the union is `'UNSPECIFIED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'TERMINATED' | 'CONTINUED_AS_NEW' | 'TIMED_OUT' | 'PAUSED' | 'UNKNOWN'`. **Note the double-L `CANCELLED`.**
- `onTestFinished(fn)` is exported from `vitest` and **may be called from inside a test body**. This is what lets `testRig` register its own teardown.
- Activity `Context.current().info` exposes `attempt: number`, `scheduleToCloseTimeoutMs: number`, `startToCloseTimeoutMs: number`, and `heartbeatTimeoutMs?: number` (optional — only present when declared).
- `ContractClient` has a **private constructor**; wrap it with a `Proxy`, do not subclass.
- The three start methods are `startWorkflow`, `executeWorkflow`, and `signalWithStart`.

---

### Task 1: The `testRig` replay-harvest helper

**Files:**

- Create: `packages/testing/src/test-rig.ts`
- Create: `packages/testing/src/test-rig.spec.ts`
- Modify: `packages/testing/package.json` (add `src/test-rig.ts` to the `build` script's tsdown entry list, and a `./test-rig` subpath export)
- Modify: `packages/testing/typedoc.json` (add the entry point)

**Interfaces:**

- Consumes: `bundleFor` / `withTaskQueue` / `nextTaskQueueId` from `@temporal-contract/testing/workflow-bundle` (callers still use these; the rig does not).
- Produces:
  - `testRig(testEnv, options): Promise<{ worker: TypedWorker; client: ContractClient<TContract> }>` where `options` is `{ contract, bundle, activities? }`.
  - `REPLAY_SKIP_ALLOWLIST: Record<string, string>` — workflow-ID **prefix** → reason.
  - `isTerminalStatus(name: string): boolean` — exported for its own unit test.
  - `skipReasonFor(workflowId: string, allowlist: Record<string, string>): string | undefined` —
    exported so the allowlist-matching rule is unit-testable without a server.

- [ ] **Step 1: Write the failing unit tests for the pure parts**

Create `packages/testing/src/test-rig.spec.ts`:

```ts
import { describe, expect, it } from "vitest";

import { isTerminalStatus, REPLAY_SKIP_ALLOWLIST, skipReasonFor } from "./test-rig.js";

describe("isTerminalStatus", () => {
  it("treats every finished status as terminal", () => {
    for (const name of ["COMPLETED", "FAILED", "CANCELLED", "TERMINATED", "TIMED_OUT"]) {
      expect(isTerminalStatus(name)).toBe(true);
    }
  });

  it("treats CONTINUED_AS_NEW as terminal — that run's history is complete and replayable", () => {
    expect(isTerminalStatus("CONTINUED_AS_NEW")).toBe(true);
  });

  it("treats unfinished statuses as non-terminal", () => {
    for (const name of ["RUNNING", "PAUSED", "UNSPECIFIED", "UNKNOWN"]) {
      expect(isTerminalStatus(name)).toBe(false);
    }
  });
});

describe("skipReasonFor", () => {
  it("matches an allowlist entry by workflow-ID prefix", () => {
    expect(skipReasonFor("probe-edge-cases-1", { "probe-edge-cases": "blocks forever" })).toBe(
      "blocks forever",
    );
  });

  it("returns undefined for an unlisted id, so the caller can fail", () => {
    expect(
      skipReasonFor("some-other-id", { "probe-edge-cases": "blocks forever" }),
    ).toBeUndefined();
  });

  it("ships an allowlist whose every entry carries a non-empty reason", () => {
    for (const [prefix, reason] of Object.entries(REPLAY_SKIP_ALLOWLIST)) {
      expect(reason, `allowlist entry "${prefix}" needs a reason`).not.toBe("");
    }
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/testing && pnpm vitest run src/test-rig.spec.ts`
Expected: FAIL — `Cannot find module './test-rig.js'`

- [ ] **Step 3: Write the implementation**

Create `packages/testing/src/test-rig.ts`:

```ts
import type { ContractClient } from "@temporal-contract/client";
import { TypedClient } from "@temporal-contract/client";
import type { ContractDefinition } from "@temporal-contract/contract";
// `ActivitiesHandler` lives on the /activity subpath — worker.ts imports it
// but does not re-export it. `TypedWorker` is both a type and a value, so one
// non-type import covers both uses.
import type { ActivitiesHandler } from "@temporal-contract/worker/activity";
import { TypedWorker } from "@temporal-contract/worker/worker";
import type { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import type { WorkflowBundleWithSourceMap } from "@temporalio/worker";
import { onTestFinished } from "vitest";

/**
 * Workflow-ID prefixes whose executions are deliberately left non-terminal, so
 * their histories cannot be replayed. Every entry needs a reason.
 *
 * This list may only ever shrink. A silently-skipped execution would report
 * replay coverage it does not have — exactly the rot this rig exists to
 * prevent — so an unlisted non-terminal execution fails the test instead.
 */
export const REPLAY_SKIP_ALLOWLIST: Record<string, string> = {};

/** Statuses whose history is complete and therefore replayable. */
const TERMINAL_STATUSES = new Set([
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "TERMINATED",
  "TIMED_OUT",
  // The run ended; the next run is a separate execution with its own history.
  "CONTINUED_AS_NEW",
]);

export function isTerminalStatus(name: string): boolean {
  return TERMINAL_STATUSES.has(name);
}

export function skipReasonFor(
  workflowId: string,
  allowlist: Record<string, string>,
): string | undefined {
  for (const [prefix, reason] of Object.entries(allowlist)) {
    if (workflowId.startsWith(prefix)) return reason;
  }
  return undefined;
}

/** The three `ContractClient` methods that can start an execution. */
const START_METHODS = new Set(["startWorkflow", "executeWorkflow", "signalWithStart"]);

type RigOptions<TContract extends ContractDefinition> = {
  readonly contract: TContract;
  readonly bundle: WorkflowBundleWithSourceMap;
  readonly activities?: ActivitiesHandler<TContract>;
};

/**
 * Build the worker + client pair every in-process test needs, and register an
 * `onTestFinished` hook that replays the history of every execution the client
 * started.
 *
 * The rig deliberately does NOT scope the task queue — callers keep calling
 * `withTaskQueue` themselves. A same-workflow continue-as-new must land on the
 * contract's static queue, because the contract is closed over inside the
 * bundled workflow module and a test-side copy can never reach it.
 */
export async function testRig<TContract extends ContractDefinition>(
  testEnv: TestWorkflowEnvironment,
  options: RigOptions<TContract>,
): Promise<{ worker: TypedWorker; client: ContractClient<TContract> }> {
  const { contract, bundle, activities } = options;

  const worker = await TypedWorker.create({
    contract,
    connection: testEnv.nativeConnection,
    workflowBundle: bundle,
    // Spread conditionally: `TypedWorker.create` distinguishes an absent
    // `activities` key from `activities: undefined` (a workflow-only worker
    // must not register an activity poller).
    ...(activities !== undefined ? { activities } : {}),
  }).get();

  const typedClient = await TypedClient.create({ client: testEnv.client }).get();
  const bound = typedClient.for(contract);

  const startedIds: string[] = [];

  const client = new Proxy(bound, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof property !== "string" || !START_METHODS.has(property)) return value;
      if (typeof value !== "function") return value;

      return (...args: readonly unknown[]) => {
        const bag = args[1];
        const workflowId =
          typeof bag === "object" && bag !== null && "workflowId" in bag
            ? (bag as { workflowId?: unknown }).workflowId
            : undefined;
        if (typeof workflowId === "string") startedIds.push(workflowId);
        return (value as (...rest: readonly unknown[]) => unknown).apply(target, args);
      };
    },
  }) as ContractClient<TContract>;

  onTestFinished(async () => {
    for (const workflowId of startedIds) {
      const handle = testEnv.client.workflow.getHandle(workflowId);
      const described = await handle.describe();

      if (!isTerminalStatus(described.status.name)) {
        const reason = skipReasonFor(workflowId, REPLAY_SKIP_ALLOWLIST);
        if (reason === undefined) {
          throw new Error(
            `Workflow "${workflowId}" ended ${described.status.name}, so its history cannot be ` +
              `replayed and this test proves nothing about replay determinism for it. Either make ` +
              `the execution terminal, or add a REPLAY_SKIP_ALLOWLIST entry in ` +
              `packages/testing/src/test-rig.ts with a reason.`,
          );
        }
        continue;
      }

      const history = await handle.fetchHistory();
      await Worker.runReplayHistory({ workflowBundle: bundle }, history, workflowId);
    }
  });

  return { worker, client };
}
```

- [ ] **Step 4: Run the unit tests to verify they pass**

Run: `cd packages/testing && pnpm vitest run src/test-rig.spec.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Wire the subpath export**

In `packages/testing/package.json`, append `src/test-rig.ts` to the `build` script's tsdown entry list, and add to `"exports"` (alphabetical, matching the existing block):

```json
    "./test-rig": {
      "types": "./dist/test-rig.d.mts",
      "import": "./dist/test-rig.mjs"
    },
```

In `packages/testing/typedoc.json`, add `"src/test-rig.ts"` to `entryPoints`.

- [ ] **Step 6: Verify the package builds and typechecks**

Run: `pnpm turbo run build typecheck lint --filter=@temporal-contract/testing`
Expected: all pass; `packages/testing/dist/test-rig.mjs` exists.

- [ ] **Step 7: Commit**

```bash
git add packages/testing/src/test-rig.ts packages/testing/src/test-rig.spec.ts \
        packages/testing/package.json packages/testing/typedoc.json
git commit -m "test(testing): add the testRig replay-harvest helper"
```

---

### Task 2: Prove the rig on `replay.inprocess.spec.ts`

This file already replays manually, so it is the one place with a known-good expectation to check the rig against.

**Files:**

- Modify: `packages/worker/src/__tests__/replay.inprocess.spec.ts`

**Interfaces:**

- Consumes: `testRig` from `@temporal-contract/testing/test-rig` (Task 1).
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Replace the manual construction and manual replay loop**

Delete the trailing `for (const workflowId of [happyId, declinedId]) { … runReplayHistory … }` block and the `TypedWorker.create` / `TypedClient.create` lines, replacing them with:

```ts
const { worker, client } = await testRig(testEnv, {
  contract: inprocessContract,
  bundle: await bundleFor(fixturePath(import.meta.url, "inprocess.workflows")),
  activities,
});
```

Keep every `expect` in the test body unchanged.

- [ ] **Step 2: Run and confirm still green**

Run: `cd packages/worker && pnpm vitest run --project integration-inprocess src/__tests__/replay.inprocess.spec.ts`
Expected: PASS. The replay now happens in the rig's teardown rather than inline.

- [ ] **Step 3: Prove the rig's replay actually runs**

The danger is a teardown that silently does nothing. Temporarily break it: in `test-rig.ts`, change `Worker.runReplayHistory({ workflowBundle: bundle }, history, workflowId)` to replay against a **different** workflow module — e.g. `{ workflowsPath: fixturePath(import.meta.url, "handlers.workflows") }` hardcoded — and confirm the test now FAILS with a replay error. Restore afterwards.

Quote the verbatim failure in your report. A teardown never observed failing is not known to run.

- [ ] **Step 4: Commit**

```bash
git add packages/worker/src/__tests__/replay.inprocess.spec.ts
git commit -m "test(worker): move replay.inprocess.spec.ts onto the rig"
```

---

### Task 3: Migrate `handlers` and `activity-options` to the rig

The two largest suites, covering signals, queries, updates, and the activity-options merge layers.

**Files:**

- Modify: `packages/worker/src/__tests__/handlers.inprocess.spec.ts`
- Modify: `packages/worker/src/__tests__/activity-options.inprocess.spec.ts`

**Interfaces:**

- Consumes: `testRig` (Task 1).
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Rewrite each test's construction**

In every test, replace this pair:

```ts
const worker = await TypedWorker.create({
  contract,
  connection: testEnv.nativeConnection,
  workflowBundle: bundle,
  activities,
}).get();
const typedClient = await TypedClient.create({ client: testEnv.client }).get();
const client = typedClient.for(contract);
```

with:

```ts
const { worker, client } = await testRig(testEnv, { contract, bundle, activities });
```

Leave `withTaskQueue` / `nextTaskQueueId` / `bundleFor` calls exactly as they are — the rig does not scope the queue.

For workflow-only tests (no `activities` variable in scope), omit the key entirely rather than passing `activities: undefined`.

**Do not change any assertion.** This task is mechanical; a changed expectation is a defect.

- [ ] **Step 2: Run and triage**

Run: `cd packages/worker && pnpm vitest run --project integration-inprocess src/__tests__/handlers.inprocess.spec.ts src/__tests__/activity-options.inprocess.spec.ts`

Three outcomes, and they must be distinguished in your report:

1. **PASS** — the rig replayed every history cleanly.
2. **FAIL: non-terminal execution** — the rig's own error message names the workflow ID. `handlers.workflows.ts`'s `probeEdgeCases` and `transformWorkflow` block on `condition(() => false)` and are expected here. Add a `REPLAY_SKIP_ALLOWLIST` entry keyed by the workflow-ID prefix with a reason naming why it never terminates.
3. **FAIL: `DeterminismViolationError` or `ReplayError`** — **STOP.** This is a real determinism bug in shipped code. Report it with the workflow, the history, and the error. Do not allowlist it, do not adjust the test.

- [ ] **Step 3: Run the whole in-process tier to catch cross-file effects**

Run: `cd packages/worker && pnpm vitest run --project integration-inprocess`
Expected: PASS, with the same test count as before the migration.

- [ ] **Step 4: Commit**

```bash
git add packages/worker/src/__tests__/handlers.inprocess.spec.ts \
        packages/worker/src/__tests__/activity-options.inprocess.spec.ts \
        packages/testing/src/test-rig.ts
git commit -m "test(worker): move handlers and activity-options onto the rig"
```

---

### Task 4: Migrate `cancellation` and `continue-as-new` to the rig

The two trickiest: cancellation produces `CANCELLED` terminal states, and continue-as-new produces `CONTINUED_AS_NEW` plus a chain of follow-on runs.

**Files:**

- Modify: `packages/worker/src/__tests__/cancellation.inprocess.spec.ts`
- Modify: `packages/worker/src/__tests__/continue-as-new.inprocess.spec.ts`

**Interfaces:**

- Consumes: `testRig` (Task 1).
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Rewrite each test's construction**

Same mechanical replacement as Task 3 — replace the `TypedWorker.create` + `TypedClient.create` + `.for(contract)` trio with:

```ts
const { worker, client } = await testRig(testEnv, { contract, bundle, activities });
```

`continue-as-new.inprocess.spec.ts` shares the static queue for six tests and documents why in a `SHARED STATIC QUEUE CAVEAT` block. **Leave that alone** — the rig does not touch the queue, so the caveat still holds and the tests still work.

- [ ] **Step 2: Run and triage**

Run: `cd packages/worker && pnpm vitest run --project integration-inprocess src/__tests__/cancellation.inprocess.spec.ts src/__tests__/continue-as-new.inprocess.spec.ts`

Two specific things to expect:

- **Cancelled executions replay fine** — `CANCELLED` is terminal and its history is complete. If one does not replay, that is outcome 3 below.
- **Continue-as-new**: `getHandle(workflowId)` with no run ID resolves to the _latest_ run in the chain (verified in workstream 1 against `workflow-client.js:149`). So the recorded ID replays the final run's history, not the first. That is correct and sufficient — the whole chain ran the same workflow code. Note this in your report so a later reader does not mistake it for a gap.

Same three outcomes as Task 3. A `DeterminismViolationError` means **STOP and report**.

- [ ] **Step 3: Run the whole in-process tier**

Run: `cd packages/worker && pnpm vitest run --project integration-inprocess`
Expected: PASS, same test count as before.

- [ ] **Step 4: Commit**

```bash
git add packages/worker/src/__tests__/cancellation.inprocess.spec.ts \
        packages/worker/src/__tests__/continue-as-new.inprocess.spec.ts \
        packages/testing/src/test-rig.ts
git commit -m "test(worker): move cancellation and continue-as-new onto the rig"
```

---

### Task 5: Migrate the remaining in-process specs

**Files:**

- Modify: `packages/worker/src/__tests__/child-wire.inprocess.spec.ts`
- Modify: `packages/worker/src/__tests__/rehydration.inprocess.spec.ts`
- Modify: `packages/worker/src/__tests__/time-skipping.inprocess.spec.ts`
- Modify: `packages/worker/src/__tests__/registration.inprocess.spec.ts`

**Interfaces:**

- Consumes: `testRig` (Task 1).
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Rewrite construction in the three straightforward files**

`child-wire`, `rehydration`, and `time-skipping` take the same mechanical replacement as Task 3.

- [ ] **Step 2: Handle `registration.inprocess.spec.ts` carefully — it must NOT use the rig for worker creation**

`TypedWorker.create` skips `verifyWorkflowRegistration` whenever `workflowsPath` is absent, and it is always absent for a prebuilt bundle. `registration.inprocess.spec.ts` passes `workflowsPath` deliberately, and its file header documents this.

Several of its tests also assert on the **creation Result itself** (that creation defects), so there is no worker to hand back.

Therefore: **leave worker creation in that file exactly as it is.** Use the rig only where a test successfully creates a worker and starts a workflow, and only for the client half. If that is awkward, leave the file entirely unmigrated and record it — replay coverage of the registration fixtures is not worth breaking the one constraint the whole file exists to test.

State which choice you made and why in your report.

- [ ] **Step 3: Run and triage**

Run: `cd packages/worker && pnpm vitest run --project integration-inprocess`

Same three outcomes as Task 3. `DeterminismViolationError` means **STOP and report**.

- [ ] **Step 4: Confirm the allowlist is honest**

Run: `grep -A 3 "REPLAY_SKIP_ALLOWLIST" packages/testing/src/test-rig.ts`

Every entry must name a workflow that genuinely never terminates, with a reason that says why. If an entry exists only because replay was failing for another cause, remove it and fix the cause.

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/__tests__/ packages/testing/src/test-rig.ts
git commit -m "test(worker): move the remaining in-process specs onto the rig"
```

---

### Task 6: Prove `nonRetryable` by attempt count

The invariant that reframed this workstream: today `nonRetryable` is asserted only as a field on the wire failure.

**Files:**

- Create: `packages/worker/src/__tests__/retry.contract.ts`
- Create: `packages/worker/src/__tests__/retry.workflows.ts`
- Create: `packages/worker/src/__tests__/retry.inprocess.spec.ts`

**Interfaces:**

- Consumes: `testRig` (Task 1), `bundleFor` / `withTaskQueue` / `nextTaskQueueId` / `fixturePath` from `@temporal-contract/testing/workflow-bundle`.
- Produces: `retryContract`.

- [ ] **Step 1: Write the contract with two errors differing only in retryability**

Create `packages/worker/src/__tests__/retry.contract.ts`:

```ts
import { defineActivity, defineContract, defineWorkflow } from "@temporal-contract/contract";
import { z } from "zod";

// Composition-first: resources defined individually, then composed.

/**
 * Two declared errors identical but for `nonRetryable`. The activity chooses
 * which to raise from its input, so a single fixture proves both directions
 * and the only variable between them is the flag under test.
 *
 * `maximumAttempts: 3` bounds the retryable case: it must retry (proving the
 * flag reached Temporal) without retrying forever if the flag regresses.
 */
const flaky = defineActivity({
  input: z.object({ mode: z.enum(["terminal", "retryable"]) }),
  output: z.object({ attempts: z.number() }),
  errors: {
    TerminalFailure: { data: z.object({ at: z.number() }), nonRetryable: true },
    RetryableFailure: { data: z.object({ at: z.number() }), nonRetryable: false },
  },
  activityOptions: {
    startToCloseTimeout: "10 seconds",
    retry: { maximumAttempts: 3, backoffCoefficient: 1, initialInterval: "1 second" },
  },
});

const runsFlaky = defineWorkflow({
  input: z.object({ mode: z.enum(["terminal", "retryable"]) }),
  output: z.object({ outcome: z.string(), attempts: z.number() }),
  activities: { flaky },
});

export const retryContract = defineContract({
  taskQueue: "retry-tests",
  workflows: { runsFlaky },
});
```

- [ ] **Step 2: Write the workflow**

Create `packages/worker/src/__tests__/retry.workflows.ts`:

```ts
import { ContractError, declareWorkflow } from "../workflow.js";
import { retryContract } from "./retry.contract.js";

export const runsFlaky = declareWorkflow({
  workflowName: "runsFlaky",
  contract: retryContract,
  implementation: async (context, args) => {
    const result = await context.activities.flaky({ mode: args.mode });

    // Fold the failure into a returned status rather than rethrowing: a
    // rethrown defect becomes a Workflow-Task retry loop that time-skipping
    // cannot fast-forward past, turning a regression into a 120s hang.
    if (result.isDefect()) return { outcome: `defect:${String(result.cause)}`, attempts: -1 };
    if (result.isErr()) {
      const error = result.error;
      if (error instanceof ContractError) {
        // `data.at` carries the attempt number the activity failed on.
        const at = (error.data as { at: number }).at;
        return { outcome: `err:${error.errorName}`, attempts: at };
      }
      return { outcome: `err:${error.name}`, attempts: -1 };
    }
    return { outcome: "ok", attempts: result.value.attempts };
  },
});
```

- [ ] **Step 3: Write the failing spec**

Create `packages/worker/src/__tests__/retry.inprocess.spec.ts`:

```ts
import { it } from "@temporal-contract/testing/time-skipping";
import { testRig } from "@temporal-contract/testing/test-rig";
import {
  bundleFor,
  fixturePath,
  nextTaskQueueId,
  withTaskQueue,
} from "@temporal-contract/testing/workflow-bundle";
import { Context } from "@temporalio/activity";
import { describe, expect } from "vitest";
import { ErrAsync } from "unthrown";

import { declareActivitiesHandler } from "../activity.js";
import { retryContract } from "./retry.contract.js";

const WORKFLOW_EXECUTION_TIMEOUT = "30 seconds";

describe("nonRetryable is a behavior, not a field", () => {
  it("stops after exactly one attempt when the declared error is nonRetryable", async ({
    testEnv,
  }) => {
    const contract = withTaskQueue(retryContract, nextTaskQueueId("retry-terminal"));
    const bundle = await bundleFor(fixturePath(import.meta.url, "retry.workflows"));

    const activities = declareActivitiesHandler({
      contract,
      activities: {
        runsFlaky: {
          // Always fails. `Context.current().info.attempt` is Temporal's own
          // attempt counter, so the assertion reads what the server did.
          flaky: (_input, { errors }) =>
            ErrAsync(errors.TerminalFailure({ at: Context.current().info.attempt })),
        },
      },
    });

    const { worker, client } = await testRig(testEnv, { contract, bundle, activities });

    const result = await worker.raw.runUntil(
      client
        .executeWorkflow("runsFlaky", {
          workflowId: "retry-terminal",
          args: { mode: "terminal" },
          workflowExecutionTimeout: WORKFLOW_EXECUTION_TIMEOUT,
        })
        .getOrThrow(),
    );

    // The whole point: attempt 1 and no more. A regression that dropped
    // `nonRetryable` on the wire would let Temporal retry to 3.
    expect(result).toEqual({ outcome: "err:TerminalFailure", attempts: 1 });
  });

  it("retries when the declared error is retryable", async ({ testEnv }) => {
    const contract = withTaskQueue(retryContract, nextTaskQueueId("retry-retryable"));
    const bundle = await bundleFor(fixturePath(import.meta.url, "retry.workflows"));

    const activities = declareActivitiesHandler({
      contract,
      activities: {
        runsFlaky: {
          flaky: (_input, { errors }) =>
            ErrAsync(errors.RetryableFailure({ at: Context.current().info.attempt })),
        },
      },
    });

    const { worker, client } = await testRig(testEnv, { contract, bundle, activities });

    const result = await worker.raw.runUntil(
      client
        .executeWorkflow("runsFlaky", {
          workflowId: "retry-retryable",
          args: { mode: "retryable" },
          workflowExecutionTimeout: WORKFLOW_EXECUTION_TIMEOUT,
        })
        .getOrThrow(),
    );

    // Exhausts the declared `maximumAttempts: 3`, so the surfaced failure is
    // from attempt 3 — proving Temporal really retried.
    expect(result).toEqual({ outcome: "err:RetryableFailure", attempts: 3 });
  });
});
```

- [ ] **Step 4: Run**

Run: `cd packages/worker && pnpm vitest run --project integration-inprocess src/__tests__/retry.inprocess.spec.ts`
Expected: PASS (2 tests).

If the retryable case reports `attempts: 1`, that is a **real finding** — it would mean `nonRetryable: false` is not reaching Temporal. Report it; do not adjust the expectation.

- [ ] **Step 5: Reality-check both assertions against production source**

Break `packages/worker/src/contract-errors.ts`'s `nonRetryable: definition.nonRetryable ?? false` — hardcode it to `false`, confirm the terminal test now reports `attempts: 3` and fails; then hardcode `true` and confirm the retryable test reports `attempts: 1` and fails. Restore.

Quote both verbatim failures. Production source must be byte-identical afterwards.

- [ ] **Step 6: Add the knip entry and commit**

`knip.json` already globs `src/__tests__/*.workflows.ts`, so no change is needed — verify with `pnpm knip`.

```bash
git add packages/worker/src/__tests__/retry.contract.ts \
        packages/worker/src/__tests__/retry.workflows.ts \
        packages/worker/src/__tests__/retry.inprocess.spec.ts
git commit -m "test(worker): prove nonRetryable by attempt count, not by field"
```

---

### Task 7: Prove timeout forwarding via `Context.current().info`

**Files:**

- Create: `packages/worker/src/__tests__/timeouts.contract.ts`
- Create: `packages/worker/src/__tests__/timeouts.workflows.ts`
- Create: `packages/worker/src/__tests__/timeouts.inprocess.spec.ts`

**Interfaces:**

- Consumes: `testRig` (Task 1).
- Produces: `timeoutsContract`.

- [ ] **Step 1: Write a contract exercising all three merge layers**

Create `packages/worker/src/__tests__/timeouts.contract.ts`:

```ts
import { defineActivity, defineContract, defineWorkflow } from "@temporal-contract/contract";
import { z } from "zod";

/**
 * The activity reports back the timeouts Temporal actually materialized for
 * its task, so each layer of the merge is proven by effect rather than by
 * inspecting the options we passed in.
 *
 * `heartbeatTimeout` is the one this repo asserted nowhere before — a lost
 * heartbeat timeout means a dead activity is never retried.
 */
const reportsTimeouts = defineActivity({
  input: z.object({}),
  output: z.object({
    startToCloseMs: z.number(),
    scheduleToCloseMs: z.number(),
    heartbeatMs: z.number(),
  }),
  // Contract layer: heartbeat declared here and nowhere else.
  activityOptions: {
    heartbeatTimeout: "7 seconds",
    retry: { maximumAttempts: 1 },
  },
});

const reportsLayered = defineWorkflow({
  input: z.object({}),
  output: z.object({
    startToCloseMs: z.number(),
    scheduleToCloseMs: z.number(),
    heartbeatMs: z.number(),
  }),
  activities: { reportsTimeouts },
});

export const timeoutsContract = defineContract({
  taskQueue: "timeouts-tests",
  workflows: { reportsLayered },
});
```

- [ ] **Step 2: Write the workflow supplying the other two layers**

Create `packages/worker/src/__tests__/timeouts.workflows.ts`:

```ts
import { declareWorkflow } from "../workflow.js";
import { timeoutsContract } from "./timeouts.contract.js";

export const reportsLayered = declareWorkflow({
  workflowName: "reportsLayered",
  contract: timeoutsContract,
  // Workflow-wide layer.
  activityOptions: { scheduleToCloseTimeout: "20 seconds" },
  // Per-activity layer — most specific, must win for startToClose.
  activityOptionsByName: { reportsTimeouts: { startToCloseTimeout: "9 seconds" } },
  implementation: async (context) => {
    const result = await context.activities.reportsTimeouts({});

    if (result.isDefect()) throw result.cause;
    if (result.isErr()) return { startToCloseMs: -1, scheduleToCloseMs: -1, heartbeatMs: -1 };
    return result.value;
  },
});
```

- [ ] **Step 3: Write the spec**

Create `packages/worker/src/__tests__/timeouts.inprocess.spec.ts`:

```ts
import { it } from "@temporal-contract/testing/time-skipping";
import { testRig } from "@temporal-contract/testing/test-rig";
import {
  bundleFor,
  fixturePath,
  nextTaskQueueId,
  withTaskQueue,
} from "@temporal-contract/testing/workflow-bundle";
import { Context } from "@temporalio/activity";
import { describe, expect } from "vitest";
import { OkAsync } from "unthrown";

import { declareActivitiesHandler } from "../activity.js";
import { timeoutsContract } from "./timeouts.contract.js";

const WORKFLOW_EXECUTION_TIMEOUT = "30 seconds";

describe("activity timeouts reach Temporal through every merge layer", () => {
  it("materializes the value each layer contributed", async ({ testEnv }) => {
    const contract = withTaskQueue(timeoutsContract, nextTaskQueueId("timeouts"));
    const bundle = await bundleFor(fixturePath(import.meta.url, "timeouts.workflows"));

    const activities = declareActivitiesHandler({
      contract,
      activities: {
        reportsLayered: {
          // Reads what Temporal actually scheduled the task with, rather than
          // what we passed in — an effect, not a call shape.
          reportsTimeouts: () => {
            const info = Context.current().info;
            return OkAsync({
              startToCloseMs: info.startToCloseTimeoutMs,
              scheduleToCloseMs: info.scheduleToCloseTimeoutMs,
              // `heartbeatTimeoutMs` is optional on ActivityInfo — 0
              // distinguishes "declared but lost in the merge" from "never
              // declared", so the assertion below fails loudly either way.
              heartbeatMs: info.heartbeatTimeoutMs ?? 0,
            });
          },
        },
      },
    });

    const { worker, client } = await testRig(testEnv, { contract, bundle, activities });

    const result = await worker.raw.runUntil(
      client
        .executeWorkflow("reportsLayered", {
          workflowId: "timeouts-layered",
          args: {},
          workflowExecutionTimeout: WORKFLOW_EXECUTION_TIMEOUT,
        })
        .getOrThrow(),
    );

    expect(result).toEqual({
      startToCloseMs: 9_000, // activityOptionsByName wins — most specific layer
      scheduleToCloseMs: 20_000, // declareWorkflow's workflow-wide default
      heartbeatMs: 7_000, // contract-level, the layer with no competitor
    });
  });
});
```

- [ ] **Step 4: Run**

Run: `cd packages/worker && pnpm vitest run --project integration-inprocess src/__tests__/timeouts.inprocess.spec.ts`
Expected: PASS.

`heartbeatMs: 0` would mean the contract-level heartbeat is lost in the merge — a **real finding**. Report it; do not adjust the expectation.

- [ ] **Step 5: Reality-check each of the three values**

Break the merge in `packages/worker/src/internal.ts` — drop each layer in turn from the spread — and confirm the corresponding field changes and the test fails. Restore. Quote all three verbatim failures.

- [ ] **Step 6: Commit**

```bash
git add packages/worker/src/__tests__/timeouts.contract.ts \
        packages/worker/src/__tests__/timeouts.workflows.ts \
        packages/worker/src/__tests__/timeouts.inprocess.spec.ts
git commit -m "test(worker): prove timeout forwarding through every merge layer"
```

---

### Task 8: Final verification

- [ ] **Step 1: Full suite**

Run: `pnpm turbo run typecheck lint test` — report exact task counts.
Run: `cd packages/worker && pnpm vitest run --project unit` — report exact counts.
Run: `cd packages/worker && pnpm vitest run --project integration-inprocess` — report exact counts.
Run: `cd packages/testing && pnpm vitest run` — report exact counts.
Run: `pnpm knip` — must stay clean.

- [ ] **Step 2: Docker integration, serially**

Run: `pnpm turbo run test:integration --concurrency=1`

The script now runs the two tiers sequentially (fixed in workstream 1). If a test fails, re-run that file alone to distinguish a genuine failure from contention.

- [ ] **Step 3: Measure wall-clock**

Run: `cd packages/worker && time pnpm vitest run --project integration-inprocess`

The pre-workstream-2 baseline is ~39s for unit+in-process combined. Report the new number and the delta. Replay needs no server, but it is not free.

- [ ] **Step 4: Audit the skip allowlist**

Report every `REPLAY_SKIP_ALLOWLIST` entry with its reason, and confirm each names a workflow that genuinely never reaches a terminal state. An entry that exists to silence a replay failure is a defect, not an exemption.

- [ ] **Step 5: Report replay coverage**

State how many executions were replayed across the in-process tier and how many were skipped. This is the number that says whether the harvest worked.

---

## Deferred (explicitly out of scope)

- Idempotency surface (reuse/conflict policy, safe defaults) — workstream 4.
- Cancellation semantics — proven in workstream 1.
- Raising the Stryker `break` threshold — the baseline is one nightly old.
- The `withTestWorker` boilerplate refactor flagged in workstream 1's final review — `testRig` supersedes part of it, but consolidating the remaining ~500 lines of standup is a separate cleanup.
