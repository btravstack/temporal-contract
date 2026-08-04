# Uniform `AsyncResult` for Activity Calls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every workflow-side activity call return `AsyncResult`, so the call convention no longer depends on whether the contract declared an `errors` map — without changing how Temporal classifies a propagated activity failure.

**Architecture:** `WorkflowInferActivity` loses its conditional and always returns `AsyncResult`; `makeThrowingActivity` is deleted so every activity flows through `makeResultShapedActivity`. Because re-throwing the `Err` value would change Temporal's failure classification, the worker package gains a named helper, `propagateActivityFailure`, that rethrows the _preserved original cause_. A characterization test written **before** any production change pins today's behavior and becomes the regression oracle.

**Tech Stack:** TypeScript 6.0.3, unthrown 5.0.0-beta.7 (`AsyncResult`), `@temporalio/*` 1.21.1, Vitest 4.1.10, `@temporal-contract/testing`'s `testRig` + time-skipping test server, pnpm workspaces + turbo, oxlint.

**Spec:** `docs/superpowers/specs/2026-08-04-uniform-activity-result-design.md`

## Global Constraints

- **No `any`.** Use `unknown` and narrow. Enforced by oxlint.
- **`.js` extensions in every import.** `./workflow.js`, never `./workflow`.
- **ESM only.** All packages are `"type": "module"`.
- **Never edit per-package `package.json` dependency versions** — the `catalog:` block in `pnpm-workspace.yaml` is the only place versions are bumped. This plan adds no dependencies.
- **Assert effects, never call shapes.** The governing test rule from workstream 1. A test whose assertion is "we called Temporal with X" is not acceptable; assert what the workflow actually did on the real server.
- **Error classification behavior must not change.** `classifyActivityError`, contract-error rehydration, and the cancellation discriminant keep their current behavior. This plan changes the _call convention_, not what errors mean.
- **Rule 2 (`AGENTS.md`)** — activities return `AsyncResult`; never throw. This plan exists to make the library obey its own rule.
- Conventional Commits are enforced by commitlint on a git hook. Use `feat:`, `fix:`, `test:`, `docs:`, `refactor:`.

---

## The hazard that shapes this whole plan

`packages/worker/src/__tests__/retry.workflows.ts` carries this comment, discovered the hard way:

> Fold the failure into a returned status rather than rethrowing: a rethrown defect becomes a Workflow-Task retry loop that time-skipping cannot fast-forward past, turning a regression into a 120s hang.

Two consequences you must respect:

1. **It confirms why `propagateActivityFailure` must exist.** Throwing a non-`TemporalFailure` from workflow code does not fail the workflow — it fails the _workflow task_, which Temporal retries indefinitely. `ActivityError` is a `TaggedError` (`packages/worker/src/errors.ts`, `export class ActivityError`), not a `TemporalFailure`. So `.getOrThrow()` is the **wrong** tool here and must never be recommended as the migration path.

2. **A wrong implementation makes tests hang, not fail.** Every test that exercises the propagation path MUST set a short `workflowExecutionTimeout` so a task-retry loop terminates quickly and surfaces as a distinguishable failure instead of a 120-second stall. Use `"10 seconds"` for propagation tests.

---

## Running the tests — two separate tiers

This trips people up, and I verified it rather than assuming: `pnpm --filter @temporal-contract/worker test` runs **only** the `unit` project. It does **not** run the in-process integration tests, and passing a filename after `--` does not filter anything — you get the whole unit suite regardless.

| What you want             | Command                                                                                             |
| ------------------------- | --------------------------------------------------------------------------------------------------- |
| Unit tests, filtered      | `pnpm --filter @temporal-contract/worker exec vitest run --project unit <pattern>`                  |
| In-process tier, filtered | `pnpm --filter @temporal-contract/worker exec vitest run --project integration-inprocess <pattern>` |
| Whole unit suite          | `pnpm --filter @temporal-contract/worker test`                                                      |
| Whole in-process tier     | `pnpm --filter @temporal-contract/worker exec vitest run --project integration-inprocess`           |

The in-process tier boots a Temporal test server per file (~10s each), so filter to the file you are working on while iterating. There is also a third project, `integration`, driven by `test:integration`, which uses Docker — **do not run the full `test:integration` in parallel with other work**, as concurrent container boots are a known source of flakes in this repo.

---

## File Structure

| File                                                          | Responsibility                                                                                                                                    |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/worker/src/__tests__/propagation.contract.ts`       | **Create.** Contract fixture with one activity that declares NO errors and one that does.                                                         |
| `packages/worker/src/__tests__/propagation.workflows.ts`      | **Create.** Workflow fixtures: propagate the failure, and handle it.                                                                              |
| `packages/worker/src/__tests__/propagation.inprocess.spec.ts` | **Create.** The characterization test — pins workflow status and attempt count. Written against CURRENT behavior in Task 1, unchanged thereafter. |
| `packages/worker/src/activity-failure.ts`                     | **Create.** `propagateActivityFailure`. Kept out of `activities-proxy.ts`, which is already the package's densest module.                         |
| `packages/worker/src/activities-proxy.ts`                     | **Modify.** `WorkflowInferActivity` loses its conditional; `makeThrowingActivity` deleted.                                                        |
| `packages/worker/src/index.ts`                                | **Modify.** Export `propagateActivityFailure`.                                                                                                    |
| `examples/order-processing-worker/src/**`                     | **Modify.** Migrate call sites.                                                                                                                   |
| `docs/**`                                                     | **Modify.** Migrate examples and promote the cancellation warning.                                                                                |

## Sequencing rationale

Task 1 writes the characterization test **against unchanged production code**, so it passes on the current implementation and captures what Temporal does today. That makes it a genuine regression oracle rather than a test written to match whatever the new code happens to do — the failure mode this project has hit repeatedly.

Task 2 adds the helper. Task 3 makes the change and must leave Task 1's test passing **unmodified**. Tasks 4-6 migrate consumers.

---

### Task 1: Characterization test — pin today's behavior

**Files:**

- Create: `packages/worker/src/__tests__/propagation.contract.ts`
- Create: `packages/worker/src/__tests__/propagation.workflows.ts`
- Create: `packages/worker/src/__tests__/propagation.inprocess.spec.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `propagationContract` (a `ContractDefinition` with activities `alwaysFailsNoErrors` and `alwaysFailsWithErrors`), and workflows `propagatesFailure` / `handlesFailure`.

**Critical:** this task changes NO production code. Its tests must pass against the current implementation. If a test does not pass, the characterization is wrong — fix the test, not the library.

- [ ] **Step 1: Write the contract fixture**

Create `packages/worker/src/__tests__/propagation.contract.ts`:

```ts
import { defineActivity, defineContract, defineWorkflow } from "@temporal-contract/contract";
import { z } from "zod";

/**
 * Fails on every attempt and declares NO `errors` map — so today it takes the
 * `makeThrowingActivity` path and Temporal's original `ActivityFailure`
 * propagates out of the workflow. This is the activity whose behavior must be
 * identical after the uniform-`AsyncResult` change.
 *
 * `maximumAttempts: 2` bounds the run: enough to prove Temporal retried,
 * short enough that a regression cannot stall the suite.
 */
const alwaysFailsNoErrors = defineActivity({
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
  activityOptions: {
    startToCloseTimeout: "5 seconds",
    retry: { maximumAttempts: 2, backoffCoefficient: 1, initialInterval: "1 second" },
  },
});

/** The same, but declaring an error — already on the Result path today. */
const alwaysFailsWithErrors = defineActivity({
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
  errors: {
    Boom: { data: z.object({ at: z.number() }), nonRetryable: true },
  },
  activityOptions: {
    startToCloseTimeout: "5 seconds",
    retry: { maximumAttempts: 2, backoffCoefficient: 1, initialInterval: "1 second" },
  },
});

/** Lets the activity failure escape, so Temporal decides the workflow outcome. */
const propagatesFailure = defineWorkflow({
  input: z.object({}),
  output: z.object({ reached: z.boolean() }),
  activities: { alwaysFailsNoErrors },
});

/** Catches the failure and returns normally, so the workflow completes. */
const handlesFailure = defineWorkflow({
  input: z.object({}),
  output: z.object({ outcome: z.string() }),
  activities: { alwaysFailsNoErrors },
});

export const propagationContract = defineContract({
  taskQueue: "propagation-tests",
  workflows: { propagatesFailure, handlesFailure },
  activities: { alwaysFailsWithErrors },
});
```

- [ ] **Step 2: Write the workflow fixtures against CURRENT behavior**

Create `packages/worker/src/__tests__/propagation.workflows.ts`. Note `alwaysFailsNoErrors` declares no errors, so **today** it returns a `Promise` and throws — that is what these fixtures must be written against:

```ts
import { declareWorkflow } from "../workflow.js";
import { propagationContract } from "./propagation.contract.js";

/**
 * Awaits the activity without catching. Today `alwaysFailsNoErrors` has no
 * declared errors, so this is a plain `Promise` that throws Temporal's
 * `ActivityFailure`, and Temporal fails the workflow.
 *
 * After the uniform-`AsyncResult` change this body becomes
 * `await propagateActivityFailure(context.activities.alwaysFailsNoErrors({}))`
 * and the observable outcome must be IDENTICAL.
 */
export const propagatesFailure = declareWorkflow({
  workflowName: "propagatesFailure",
  contract: propagationContract,
  implementation: async (context) => {
    await context.activities.alwaysFailsNoErrors({});
    return { reached: true };
  },
});

/**
 * Catches the failure so the workflow COMPLETES. Uses try/catch because today
 * the call throws; after the change this becomes an `isErr()` narrow.
 */
export const handlesFailure = declareWorkflow({
  workflowName: "handlesFailure",
  contract: propagationContract,
  implementation: async (context) => {
    try {
      await context.activities.alwaysFailsNoErrors({});
      return { outcome: "unexpected-success" };
    } catch {
      return { outcome: "handled" };
    }
  },
});
```

- [ ] **Step 3: Write the characterization spec**

Create `packages/worker/src/__tests__/propagation.inprocess.spec.ts`:

```ts
import { testRig } from "@temporal-contract/testing/test-rig";
import { it } from "@temporal-contract/testing/time-skipping";
import {
  bundleFor,
  fixturePath,
  nextTaskQueueId,
  withTaskQueue,
} from "@temporal-contract/testing/workflow-bundle";
import { Context } from "@temporalio/activity";
import { describe, expect } from "vitest";

import { declareActivitiesHandler } from "../activity.js";
import { propagationContract } from "./propagation.contract.js";

// Short, so a workflow-TASK retry loop (the failure mode a wrong propagation
// helper produces) times out fast instead of stalling the suite for 120s.
const WORKFLOW_EXECUTION_TIMEOUT = "10 seconds";

/**
 * These tests are a CHARACTERIZATION of behavior that must survive the
 * uniform-`AsyncResult` change. They are written against the pre-change
 * implementation and must pass unmodified afterwards. Do not adjust them to
 * match new behavior — a diff here means the change altered semantics.
 */
describe("activity failure propagation — characterization", () => {
  it("fails the workflow, after Temporal's own retries, when the failure escapes", async ({
    testEnv,
  }) => {
    const contract = withTaskQueue(propagationContract, nextTaskQueueId("prop-escape"));
    const bundle = await bundleFor(fixturePath(import.meta.url, "propagation.workflows"));

    const attempts: number[] = [];
    const activities = declareActivitiesHandler({
      contract,
      activities: {
        propagatesFailure: {
          alwaysFailsNoErrors: async () => {
            attempts.push(Context.current().info.attempt);
            // oxlint-disable-next-line unthrown/no-throw -- the activity under test must fail
            throw new Error("activity exploded");
          },
        },
        handlesFailure: {
          alwaysFailsNoErrors: async () => {
            // oxlint-disable-next-line unthrown/no-throw -- the activity under test must fail
            throw new Error("activity exploded");
          },
        },
      },
    });

    const { worker, client } = await testRig(testEnv, { contract, bundle, activities });

    const outcome = await worker.raw.runUntil(
      (async () => {
        const result = await client.executeWorkflow("propagatesFailure", {
          workflowId: "prop-escape",
          args: {},
          workflowExecutionTimeout: WORKFLOW_EXECUTION_TIMEOUT,
        });
        return result.isErr() ? "failed" : "completed";
      })(),
    );

    // The workflow must FAIL — not complete, and not spin in task retries
    // until the execution timeout. And Temporal must have retried the
    // activity to its configured maximum, proving the retry policy reached
    // the server rather than being short-circuited client-side.
    expect(outcome).toBe("failed");
    expect(attempts).toEqual([1, 2]);
  });

  it("completes the workflow when the failure is caught", async ({ testEnv }) => {
    const contract = withTaskQueue(propagationContract, nextTaskQueueId("prop-handled"));
    const bundle = await bundleFor(fixturePath(import.meta.url, "propagation.workflows"));

    const activities = declareActivitiesHandler({
      contract,
      activities: {
        propagatesFailure: {
          alwaysFailsNoErrors: async () => {
            // oxlint-disable-next-line unthrown/no-throw -- the activity under test must fail
            throw new Error("activity exploded");
          },
        },
        handlesFailure: {
          alwaysFailsNoErrors: async () => {
            // oxlint-disable-next-line unthrown/no-throw -- the activity under test must fail
            throw new Error("activity exploded");
          },
        },
      },
    });

    const { worker, client } = await testRig(testEnv, { contract, bundle, activities });

    const result = await worker.raw.runUntil(
      client
        .executeWorkflow("handlesFailure", {
          workflowId: "prop-handled",
          args: {},
          workflowExecutionTimeout: WORKFLOW_EXECUTION_TIMEOUT,
        })
        .getOrThrow(),
    );

    expect(result).toEqual({ outcome: "handled" });
  });
});
```

- [ ] **Step 4: Run the characterization suite against UNCHANGED production code**

```bash
pnpm --filter @temporal-contract/worker exec vitest run --project integration-inprocess propagation
```

Expected: **both tests PASS.** They describe how the library behaves today.

If either fails, your fixture is wrong — the library is not under test yet. Do not change production code to make them pass. Report what you observed, including the actual `attempts` array and outcome, because a mismatch here means the plan's premise about current behavior is wrong and later tasks need rethinking.

- [ ] **Step 5: Commit**

```bash
pnpm --filter @temporal-contract/worker typecheck
pnpm lint
git add packages/worker/src/__tests__/propagation.*
git commit -m "test(worker): characterize activity-failure propagation before the Result change"
```

---

### Task 2: `propagateActivityFailure`

**Files:**

- Create: `packages/worker/src/activity-failure.ts`
- Create: `packages/worker/src/activity-failure.spec.ts`
- Modify: `packages/worker/src/index.ts`

**Interfaces:**

- Consumes: `ActivityError` and `ActivityCancelledError` from `./errors.js`.
- Produces:
  `export function propagateActivityFailure<T, E>(result: AsyncResult<T, E>): Promise<T>`

**Why this exists.** `ActivityError` is a `TaggedError`, not a `TemporalFailure`. Throwing it from workflow code produces a workflow-_task_ failure that Temporal retries indefinitely, instead of failing the workflow. `classifyActivityError` already preserves the unwrapped original failure on `ActivityError`'s `cause`, so rethrowing **that** reproduces today's semantics exactly.

- [ ] **Step 1: Write the failing unit test**

Create `packages/worker/src/activity-failure.spec.ts`:

```ts
import { ApplicationFailure } from "@temporalio/common";
import { ErrAsync, OkAsync } from "unthrown";
import { describe, expect, it } from "vitest";

import { propagateActivityFailure } from "./activity-failure.js";
import { ActivityCancelledError, ActivityError } from "./errors.js";

describe("propagateActivityFailure", () => {
  it("returns the value on Ok", async () => {
    await expect(propagateActivityFailure(OkAsync({ ok: true }))).resolves.toEqual({ ok: true });
  });

  it("rethrows the PRESERVED CAUSE, not the ActivityError wrapper", async () => {
    // This is the whole point. Throwing the wrapper would make Temporal treat
    // the failure as a workflow-task failure and retry forever.
    const cause = ApplicationFailure.create({ message: "boom", type: "Boom" });
    const wrapper = new ActivityError("charge", 'Activity "charge" failed: boom', cause);

    await expect(propagateActivityFailure(ErrAsync(wrapper))).rejects.toBe(cause);
  });

  it("rethrows the wrapper itself when no cause was preserved", async () => {
    // Never lose the error identity: if there is nothing underneath, the
    // wrapper is the most informative thing available.
    const wrapper = new ActivityError("charge", 'Activity "charge" failed: opaque');

    await expect(propagateActivityFailure(ErrAsync(wrapper))).rejects.toBe(wrapper);
  });

  it("rethrows the preserved cause for a cancelled activity", async () => {
    const cause = ApplicationFailure.create({ message: "cancelled", type: "Cancelled" });
    const cancelled = new ActivityCancelledError("charge", cause);

    await expect(propagateActivityFailure(ErrAsync(cancelled))).rejects.toBe(cause);
  });

  it("rethrows a non-ActivityError error value unchanged", async () => {
    const other = new Error("something else");
    await expect(propagateActivityFailure(ErrAsync(other))).rejects.toBe(other);
  });
});
```

- [ ] **Step 2: Run it and verify it fails**

```bash
pnpm --filter @temporal-contract/worker exec vitest run --project unit activity-failure
```

Expected: failure reporting `Cannot find module './activity-failure.js'`.

- [ ] **Step 3: Implement**

Create `packages/worker/src/activity-failure.ts`:

```ts
import type { AsyncResult } from "unthrown";

import { ActivityCancelledError, ActivityError } from "./errors.js";

/**
 * Await an activity call and return its value, re-raising the failure so
 * **Temporal** decides the workflow's fate — the workflow-side equivalent of
 * "let it fail".
 *
 * Use this instead of unthrown's `.getOrThrow()`. `getOrThrow` throws the
 * `ActivityError` *wrapper*, which is a `TaggedError` and NOT a
 * `TemporalFailure`. Temporal treats a non-`TemporalFailure` thrown from
 * workflow code as a workflow-TASK failure and retries it indefinitely, so
 * the workflow never fails — it stalls until its execution timeout. This
 * helper rethrows the preserved original failure instead, which is exactly
 * what escaped the workflow before activity calls returned `AsyncResult`.
 *
 * A failure with no preserved cause rethrows the wrapper, so the error
 * identity is never lost.
 */
export async function propagateActivityFailure<T, E>(result: AsyncResult<T, E>): Promise<T> {
  const settled = await result;
  if (settled.isOk()) {
    return settled.value;
  }
  const error: unknown = settled.isErr() ? settled.error : settled.cause;
  if (error instanceof ActivityError || error instanceof ActivityCancelledError) {
    // oxlint-disable-next-line unthrown/no-throw -- deliberate re-raise: Temporal must see the original failure to classify the workflow outcome
    throw error.cause ?? error;
  }
  // oxlint-disable-next-line unthrown/no-throw -- deliberate re-raise, see above
  throw error;
}
```

**If `ActivityCancelledError` does not expose `cause`**, read `packages/worker/src/errors.ts` and adapt — the requirement is "rethrow the preserved original failure, else the wrapper", not this exact property access. Report any adaptation.

- [ ] **Step 4: Run the tests**

```bash
pnpm --filter @temporal-contract/worker exec vitest run --project unit activity-failure
```

Expected: all 5 pass.

- [ ] **Step 5: Export it**

In `packages/worker/src/index.ts`, add `propagateActivityFailure` to the public exports, following the file's existing export style.

- [ ] **Step 6: Commit**

```bash
pnpm --filter @temporal-contract/worker typecheck
pnpm lint
git add packages/worker/src/activity-failure.ts packages/worker/src/activity-failure.spec.ts packages/worker/src/index.ts
git commit -m "feat(worker): add propagateActivityFailure for Temporal-faithful re-raising"
```

---

### Task 3: Uniform `AsyncResult`, and prove the characterization still holds

**Files:**

- Modify: `packages/worker/src/activities-proxy.ts`
- Modify: `packages/worker/src/__tests__/propagation.workflows.ts`

**Interfaces:**

- Consumes: `propagateActivityFailure` from Task 2.
- Produces: `WorkflowInferActivity<TActivity>` always returning `AsyncResult`.

- [ ] **Step 1: Make the type unconditional**

In `packages/worker/src/activities-proxy.ts`, replace `WorkflowInferActivity` (the `TActivity extends { errors: ... } ? ... : ...` conditional) with:

```ts
/**
 * The error channel for an activity call: declared contract errors when the
 * activity declares an `errors` map, plus the two failures every activity can
 * produce.
 */
export type ActivityErrorsFor<TActivity extends ActivityDefinition> = TActivity extends {
  errors: infer TErrors extends Record<string, ErrorDefinition>;
}
  ? ContractErrorUnion<TErrors> | ActivityError | ActivityCancelledError
  : ActivityError | ActivityCancelledError;

/**
 * Every activity call returns an `AsyncResult` — the call convention no
 * longer depends on whether the contract declared errors, only the error
 * channel does. To let a failure escape and have Temporal decide the
 * workflow's outcome, use `propagateActivityFailure` rather than
 * unthrown's `.getOrThrow()`; see that function's documentation for why.
 */
export type WorkflowInferActivity<TActivity extends ActivityDefinition> = (
  args: ClientInferInput<TActivity>,
) => AsyncResult<ClientInferOutput<TActivity>, ActivityErrorsFor<TActivity>>;
```

Keep the existing prose about rehydration and cancellation from the old doc comment — move it onto `ActivityErrorsFor` rather than deleting it.

- [ ] **Step 2: Delete the throwing path**

In the same file, change the wrapper selection so every activity uses the Result-shaped wrapper:

```ts
(validatedActivities as Record<string, unknown>)[activityName] = makeResultShapedActivity(
  activityName,
  activityDef,
  rawActivity,
);
```

Then **delete the `makeThrowingActivity` function entirely.** Leaving it unreferenced would trip `knip`, which CI runs.

- [ ] **Step 3: Update the characterization workflow fixtures**

`packages/worker/src/__tests__/propagation.workflows.ts` — the activity now returns `AsyncResult`, so the fixtures must be rewritten. **The spec file must NOT change.** Replace the implementations with:

```ts
import { propagateActivityFailure } from "../activity-failure.js";
import { declareWorkflow } from "../workflow.js";
import { propagationContract } from "./propagation.contract.js";

/**
 * Lets the failure escape via `propagateActivityFailure`, the post-change
 * equivalent of the bare `await` this fixture used before. The
 * characterization spec asserts the workflow still FAILS and that Temporal
 * still retried the activity to its configured maximum.
 */
export const propagatesFailure = declareWorkflow({
  workflowName: "propagatesFailure",
  contract: propagationContract,
  implementation: async (context) => {
    await propagateActivityFailure(context.activities.alwaysFailsNoErrors({}));
    return { reached: true };
  },
});

/** Handles the failure by narrowing, so the workflow completes. */
export const handlesFailure = declareWorkflow({
  workflowName: "handlesFailure",
  contract: propagationContract,
  implementation: async (context) => {
    const result = await context.activities.alwaysFailsNoErrors({});
    if (result.isErr() || result.isDefect()) {
      return { outcome: "handled" };
    }
    return { outcome: "unexpected-success" };
  },
});
```

- [ ] **Step 4: Run the characterization suite — the central gate of this plan**

```bash
pnpm --filter @temporal-contract/worker exec vitest run --project integration-inprocess propagation
```

Expected: **both tests pass, with the spec file byte-identical to Task 1.**

Confirm with `git diff --stat packages/worker/src/__tests__/propagation.inprocess.spec.ts` — it must show **no changes**. If you needed to touch the spec to make it pass, the change altered observable semantics: stop and report, rather than adjusting the assertions.

If the first test hangs rather than failing, that is the workflow-task retry loop described at the top of this plan — it means the propagation path is throwing a non-`TemporalFailure`. Report it; do not raise the timeout to mask it.

- [ ] **Step 5: Run the whole worker suite**

```bash
pnpm --filter @temporal-contract/worker test
```

Many existing tests will now fail to compile or assert wrongly — activities without declared errors return `AsyncResult` now. **Do not fix them in this task**; inventory them (file, test name, symptom) in your report. Task 4 owns them. If the suite cannot even be collected because of type errors, note that and proceed to commit only the files this task owns.

- [ ] **Step 6: Commit**

```bash
git add packages/worker/src/activities-proxy.ts packages/worker/src/__tests__/propagation.workflows.ts
git commit -m "feat(worker)!: return AsyncResult from every activity call"
```

---

### Task 4: Migrate the worker package's own call sites

**Files:**

- Modify: whichever files Task 3's inventory named (expect `packages/worker/src/__tests__/*.ts` and `packages/worker/src/*.spec.ts`)

**Interfaces:**

- Consumes: the uniform `WorkflowInferActivity` and `propagateActivityFailure`.
- Produces: a green `@temporal-contract/worker` suite.

**Framing.** Roughly 71 `activities.` call sites exist in this package. Each needs one of two treatments, and choosing wrongly silently changes what the test proves:

- The workflow **should fail** on activity failure → `await propagateActivityFailure(context.activities.x({}))`.
- The workflow **should handle** the failure → narrow with `result.isErr()` / `result.isDefect()`.

**Do not** reach for `.getOrThrow()`. It throws the wrapper and produces the task-retry stall.

**Do not** convert an assertion that previously proved "the workflow failed" into one that proves "the workflow returned an error string" — that is a weaker test. If a fixture folded a failure into a returned status deliberately (as `retry.workflows.ts` does, and says so in a comment), preserve that intent.

- [ ] **Step 1: Inventory**

```bash
pnpm --filter @temporal-contract/worker test 2>&1 | tee /tmp/worker-unit.txt
pnpm --filter @temporal-contract/worker exec vitest run --project integration-inprocess 2>&1 | tee /tmp/worker-inprocess.txt
```

Record every failing file and test. Write the list into your report **before** changing anything — it is the checklist you will verify against at the end.

- [ ] **Step 2: Migrate, file by file**

For each file, apply the two-way choice above. Read the surrounding comments first: several fixtures document _why_ they fold or rethrow, and those reasons still hold.

- [ ] **Step 3: Verify the suite is green**

```bash
pnpm --filter @temporal-contract/worker test
pnpm --filter @temporal-contract/worker exec vitest run --project integration-inprocess
pnpm --filter @temporal-contract/worker typecheck
```

Expected: all pass.

- [ ] **Step 4: Verify no test was weakened**

For every test you touched, confirm in your report that it still asserts the same _effect_ it asserted before — same workflow status, same attempt counts, same terminal state. A test that now passes for a different reason is a silent regression, and this project has shipped that exact defect before.

- [ ] **Step 5: Commit**

```bash
pnpm lint
git add packages/worker/src
git commit -m "test(worker): migrate activity call sites to the uniform Result convention"
```

---

### Task 5: Migrate the examples

**Files:**

- Modify: `examples/order-processing-worker/src/**` (11 `activities.` call sites, 7 `defineActivity` declarations across the example packages)

**Interfaces:**

- Consumes: the uniform convention and `propagateActivityFailure`.
- Produces: examples that typecheck and demonstrate the intended idiom.

**Framing.** The examples are the library's most-read documentation. Migrating them mechanically to `propagateActivityFailure` everywhere would teach the wrong lesson: the _point_ of this change is that failures are visible and handled. Prefer narrowing where the example has a meaningful failure path, and use `propagateActivityFailure` only where "let Temporal fail the workflow" is genuinely the intent.

- [ ] **Step 1: Find every call site**

```bash
grep -rn 'activities\.' examples/*/src --include='*.ts'
```

- [ ] **Step 2: Migrate each, choosing narrow-vs-propagate deliberately**

For each, decide which reads better as teaching material and note the choice in your report.

- [ ] **Step 3: Verify**

```bash
pnpm turbo run typecheck --filter='./examples/*'
```

Expected: green.

- [ ] **Step 4: Commit**

```bash
pnpm lint
git add examples
git commit -m "docs(examples): adopt the uniform activity Result convention"
```

---

### Task 6: Documentation, cancellation warning, and changeset

**Files:**

- Modify: documentation under `docs/` referencing `activities.` (~107 files reference it; far fewer contain call-site code)
- Modify: `packages/worker/src/errors.ts` (promote the cancellation warning)
- Create: `.changeset/uniform-activity-result.md`

- [ ] **Step 1: Find docs with real call sites**

```bash
grep -rln 'await context\.activities\.\|await ctx\.activities\.' docs/
```

That narrower pattern finds code, not prose. Record the count in your report; update each.

- [ ] **Step 2: Promote the cancellation warning**

`packages/worker/src/errors.ts` documents on `ActivityCancelledError` that swallowing it makes a workflow complete as `Completed` instead of `Cancelled`. Its text currently scopes the hazard to errors-declaring activities — for example `ActivityError`'s comment says _"Only activities that declare an `errors` map surface this — activities without declared errors keep Temporal's native throwing behavior."_ **That sentence is now false.** Find every such statement in that file and correct it: the hazard applies to every activity now.

Verify with:

```bash
grep -n 'declare an \`errors\` map\|without declared errors' packages/worker/src/errors.ts
```

Every hit must be re-read and corrected if it scopes behavior to errors-declaring activities.

- [ ] **Step 3: Write the changeset**

Create `.changeset/uniform-activity-result.md`:

````markdown
---
"@temporal-contract/worker": major
---

Every workflow-side activity call now returns `AsyncResult`.

Previously the call convention depended on whether the contract declared an
`errors` map: activities with declared errors returned `AsyncResult`, those
without returned a `Promise` that threw. The call site gave no indication
which applied, and the throwing path contradicted the library's own
"activities never throw" convention.

**Migrating.** Where the workflow should handle the failure, narrow it:

```ts
const result = await context.activities.charge(input);
if (result.isErr()) {
  /* ... */
}
```
````

Where the failure should escape and let Temporal fail the workflow, use the
new `propagateActivityFailure` helper:

```ts
import { propagateActivityFailure } from "@temporal-contract/worker/workflow";

await propagateActivityFailure(context.activities.charge(input));
```

**Do not use unthrown's `.getOrThrow()` for this.** It throws the
`ActivityError` wrapper, which is not a `TemporalFailure`; Temporal treats
that as a workflow-_task_ failure and retries it indefinitely, so the
workflow stalls until its execution timeout instead of failing.
`propagateActivityFailure` rethrows the preserved original failure, which is
exactly what escaped the workflow before this change.

**Also note:** swallowing `ActivityCancelledError` makes a workflow complete
as `Completed` rather than `Cancelled`. That hazard previously applied only
to activities declaring an `errors` map; it now applies to every activity.

````

- [ ] **Step 4: Full verification**

```bash
pnpm turbo run typecheck
pnpm turbo run test
pnpm lint
````

Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add docs packages/worker/src/errors.ts .changeset
git commit -m "docs: migrate activity call sites and document the uniform Result convention"
```

---

## Self-Review

**1. Spec coverage.**

| Spec requirement                                                  | Task                                                                   |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `WorkflowInferActivity` unconditional                             | Task 3 Step 1                                                          |
| `makeThrowingActivity` deleted                                    | Task 3 Step 2                                                          |
| Named propagation helper in the public API                        | Task 2                                                                 |
| Helper rethrows preserved cause, not the wrapper                  | Task 2 Steps 1 and 3                                                   |
| Equivalence proven by effect: workflow status AND attempt count   | Task 1 (written pre-change) + Task 3 Step 4 (unchanged spec must pass) |
| Handled case narrows to `ActivityError \| ActivityCancelledError` | Task 1 second test, Task 3 Step 3                                      |
| Cancellation hazard documented for all activities                 | Task 6 Step 2, changeset                                               |
| Examples and docs updated, repo typecheck green                   | Tasks 5 and 6                                                          |
| Changeset records the breaking change and migration               | Task 6 Step 3                                                          |
| Error classification unchanged                                    | Global Constraints; no task touches `classifyActivityError`            |

No gaps.

**2. Placeholder scan.** No TBDs. Tasks 4-6 are migrations whose exact edits cannot be enumerated in advance — the set of affected call sites is only knowable after Task 3 lands — so they specify the decision procedure (narrow vs propagate), the prohibition (`.getOrThrow()`), and the anti-weakening check, rather than a literal diff.

**3. Type consistency.** `propagateActivityFailure`, `ActivityErrorsFor`, `WorkflowInferActivity`, `propagationContract`, `propagatesFailure`, `handlesFailure`, `alwaysFailsNoErrors`, `alwaysFailsWithErrors` are each named identically at definition and every use.

**One risk the plan cannot eliminate:** Task 1 asserts `attempts` via an array captured in the _test process_, which works because `testRig` runs the activity worker in-process. If a future change moves activity execution out of process, that assertion silently stops observing retries. The `expect(attempts).toEqual([1, 2])` form at least fails loudly if the array is empty, rather than passing vacuously — but it is worth knowing.

**A second, more likely risk:** `alwaysFailsWithErrors` is declared on the contract but exercised by no test in Task 1. It exists so Task 3 can confirm the errors-declaring path is unaffected. If Task 3 does not use it, `knip` may flag it — that is a signal the coverage is missing, not a reason to delete the fixture.
