# Mock-Free Test Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate 77 tests that assert against a faked Temporal SDK onto the real time-skipping server, and prevent the pattern from returning.

**Architecture:** Add a bundle cache to `@temporal-contract/testing` so the expensive step (workflow bundling) is paid once per path per Vitest worker instead of once per test. Per-test isolation comes from a unique task queue, injected by spreading the contract. A meta-test enforces the boundary; Stryker measures whether the surviving tests actually catch bugs.

**Tech Stack:** TypeScript (ESM), Vitest 4, `@temporalio/worker` 1.20.3, `@temporalio/testing`, unthrown 5, oxlint, Stryker.

## Global Constraints

Copied verbatim from `CLAUDE.md`. Every task's requirements implicitly include this section.

- **Workflow code is deterministic.** No `Date.now()`, `Math.random()`, `setTimeout`, `crypto.randomUUID()`, native I/O, or `process.env` inside `declareWorkflow`'s `implementation`. Use `@temporalio/workflow` primitives.
- **`.js` extensions in every import.** `./foo.js`, never `./foo` or `./foo.ts`.
- **ESM only.** All packages are `"type": "module"`.
- **No `any`.** Use `unknown` and narrow. Enforced by oxlint.
- **Catalog versions.** New dependencies go in `pnpm-workspace.yaml`'s `catalog:` block, never per-package versions.
- **Activities and the typed client return `AsyncResult<T, E>`.** `OkAsync(value)` / `ErrAsync(error)` are the constructors. Narrow with `.isOk()` / `.isErr()` / `.isDefect()` before reaching `.value` / `.error` / `.cause`.
- **Test rule for this plan:** assert effects, never call shapes. No wall-clock `sleep` in a test — use time-skipping.

## Key API Facts (verified against the installed SDK)

These were confirmed by reading `node_modules`; do not re-derive them.

- `bundleWorkflowCode(options: BundleOptions): Promise<WorkflowBundleWithSourceMap>` — exported from `@temporalio/worker`.
- `WorkerOptions.workflowBundle?: WorkflowBundleOption` — accepts `{ code, sourceMap }`.
- **`CreateWorkerOptions = Omit<WorkerOptions, "activities" | "taskQueue"> & {...}`.** `taskQueue` **cannot be passed** — `TypedWorker.create` hard-codes `taskQueue: contract.taskQueue`, spread last so it always wins. Per-test task-queue isolation is therefore achieved by spreading the **contract**, not the worker options. This is why `withTaskQueue` exists.
- `TypedWorker.create` skips `verifyWorkflowRegistration` when `workflowsPath` is absent (i.e. always, for prebuilt bundles). The `registration-*.workflows.ts` specs must keep using `workflowsPath`.
- `@temporal-contract/testing` is already a `workspace:*` devDependency of `packages/worker`, and its `testEnv` fixture is already `{ scope: "worker" }`.

---

### Task 1: Bundle cache and task-queue isolation helpers

**Files:**

- Create: `packages/testing/src/workflow-bundle.ts`
- Create: `packages/testing/src/workflow-bundle.spec.ts`
- Modify: `packages/testing/package.json` (add `./workflow-bundle` export)
- Modify: `packages/testing/tsup.config.ts` (add the entry point)

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces:
  - `bundleFor(workflowsPath: string): Promise<{ code: string; sourceMap: string }>` — memoized per path.
  - `withTaskQueue<C extends ContractDefinition>(contract: C, id: string): C` — returns a shallow copy with `taskQueue` replaced.
  - `nextTaskQueueId(prefix: string): string` — monotonic counter, deterministic (no `Math.random`).

- [ ] **Step 1: Write the failing test**

Create `packages/testing/src/workflow-bundle.spec.ts`:

```ts
import { defineContract, defineWorkflow } from "@temporal-contract/contract";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { nextTaskQueueId, withTaskQueue } from "./workflow-bundle.js";

const contract = defineContract({
  taskQueue: "original-queue",
  workflows: {
    noop: defineWorkflow({ input: z.object({}), output: z.object({}) }),
  },
});

describe("withTaskQueue", () => {
  it("replaces the task queue without mutating the original contract", () => {
    const scoped = withTaskQueue(contract, "q-1");

    expect(scoped.taskQueue).toBe("q-1");
    expect(contract.taskQueue).toBe("original-queue");
    expect(scoped.workflows).toBe(contract.workflows);
  });
});

describe("nextTaskQueueId", () => {
  it("returns a distinct id on each call", () => {
    const a = nextTaskQueueId("t");
    const b = nextTaskQueueId("t");

    expect(a).not.toBe(b);
    expect(a.startsWith("t-")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/testing && pnpm vitest run src/workflow-bundle.spec.ts`
Expected: FAIL — `Cannot find module './workflow-bundle.js'`

- [ ] **Step 3: Write the implementation**

Create `packages/testing/src/workflow-bundle.ts`:

```ts
import type { ContractDefinition } from "@temporal-contract/contract";
import { bundleWorkflowCode, type WorkflowBundleWithSourceMap } from "@temporalio/worker";

/**
 * Workflow bundles are the expensive part of standing up a test worker —
 * webpack runs over the whole workflow module graph. The time-skipping
 * `testEnv` fixture is already worker-scoped, so the environment is
 * amortized; this closes the remaining per-test cost by memoizing each
 * bundle per `workflowsPath` for the lifetime of the Vitest worker.
 *
 * Keyed by path, and the *promise* is cached (not the resolved value) so
 * concurrent callers share one in-flight bundle rather than racing.
 */
const bundles = new Map<string, Promise<WorkflowBundleWithSourceMap>>();

/**
 * Bundle `workflowsPath` once per Vitest worker and reuse it thereafter.
 * Pass the result straight to `TypedWorker.create({ workflowBundle })`.
 */
export function bundleFor(workflowsPath: string): Promise<WorkflowBundleWithSourceMap> {
  const cached = bundles.get(workflowsPath);
  if (cached) return cached;

  const bundle = bundleWorkflowCode({ workflowsPath });
  bundles.set(workflowsPath, bundle);
  return bundle;
}

/**
 * `TypedWorker.create` hard-codes `taskQueue: contract.taskQueue` and its
 * options type omits `taskQueue` entirely, so a per-test queue cannot be
 * passed through the worker options. Scope the *contract* instead.
 *
 * Returns a shallow copy — the workflow/activity definitions are shared by
 * reference, which matters: `defineContract` treats the same definition
 * object reused across scopes as one activity, not a collision.
 */
export function withTaskQueue<TContract extends ContractDefinition>(
  contract: TContract,
  id: string,
): TContract {
  return { ...contract, taskQueue: id };
}

let counter = 0;

/**
 * Monotonic task-queue id. Deliberately a counter rather than
 * `Math.random()` / `Date.now()` so a failing run is reproducible.
 */
export function nextTaskQueueId(prefix: string): string {
  counter += 1;
  return `${prefix}-${String(counter)}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/testing && pnpm vitest run src/workflow-bundle.spec.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Add the subpath export**

In `packages/testing/package.json`, add to `"exports"` (keep keys alphabetically ordered, matching the existing block):

```json
    "./workflow-bundle": {
      "types": "./dist/workflow-bundle.d.mts",
      "import": "./dist/workflow-bundle.mjs"
    },
```

In `packages/testing/tsup.config.ts`, add `"src/workflow-bundle.ts"` to the `entry` array.

- [ ] **Step 6: Verify the package builds and the export resolves**

Run: `pnpm turbo run build --filter=@temporal-contract/testing`
Expected: build succeeds and `packages/testing/dist/workflow-bundle.mjs` exists.

- [ ] **Step 7: Commit**

```bash
git add packages/testing/src/workflow-bundle.ts packages/testing/src/workflow-bundle.spec.ts \
        packages/testing/package.json packages/testing/tsup.config.ts
git commit -m "test(testing): add workflow-bundle cache and task-queue scoping helpers"
```

---

### Task 2: The `no-sdk-mocks` guard

Written **before** the migrations so the allowlist starts at the current state and shrinks with each task — the allowlist is the progress tracker.

**Files:**

- Create: `packages/testing/src/no-sdk-mocks.spec.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: an `ALLOWLIST` constant that later tasks delete entries from.

- [ ] **Step 1: Write the guard test**

Create `packages/testing/src/no-sdk-mocks.spec.ts`:

```ts
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const WORKSPACE_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * Spec files permitted to mock the Temporal SDK. Every entry needs a reason
 * naming why the behavior is unreachable on a real time-skipping server.
 *
 * This list may only ever shrink. Adding to it requires the same scrutiny as
 * disabling a lint rule: the default answer is "move the test to the
 * `inprocess` tier" — see
 * docs/superpowers/specs/2026-08-01-mock-free-test-architecture-design.md
 */
const ALLOWLIST: Record<string, string> = {
  // Tests this package's own container wiring; testcontainers is the system
  // under test, not a stand-in for Temporal's semantics.
  "packages/testing/src/global-setup.spec.ts": "testcontainers is the subject under test",
  // Asserts the Vitest fixture plumbing itself, which must be observable
  // without paying for a real environment per assertion.
  "packages/testing/src/extension.spec.ts": "fixture plumbing, not Temporal semantics",
  "packages/testing/src/time-skipping.spec.ts": "fixture plumbing, not Temporal semantics",

  // --- Migration debt. Each entry is deleted by its migration task. ---
  "packages/worker/src/workflow-proxy.spec.ts": "TODO Task 3",
  "packages/worker/src/handlers.spec.ts": "TODO Task 4",
  "packages/worker/src/cancellation.spec.ts": "TODO Task 5",
  "packages/worker/src/continue-as-new.spec.ts": "TODO Task 6",
  "packages/worker/src/wire-format.spec.ts": "TODO Task 7",
  "packages/worker/src/workflow-errors.spec.ts": "TODO Task 8",
  "packages/worker/src/worker.spec.ts": "TODO Task 9",

  // Real SDK failure objects with faked transport — satisfies the rule.
  "packages/client/src/client.spec.ts": "constructs real SDK failures; fakes only transport",
  "packages/client/src/schedule.spec.ts": "constructs real SDK failures; fakes only transport",
};

const SDK_MOCK = /vi\.mock\(\s*["'`]@temporalio\//;

async function specFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      found.push(...(await specFiles(full)));
    } else if (entry.name.endsWith(".spec.ts")) {
      found.push(full);
    }
  }
  return found;
}

describe("no SDK mocks outside the allowlist", () => {
  it("keeps Temporal's real semantics under test", async () => {
    const files = await specFiles(join(WORKSPACE_ROOT, "packages"));
    const offenders: string[] = [];

    for (const file of files) {
      const rel = relative(WORKSPACE_ROOT, file);
      const source = await readFile(file, "utf8");
      if (SDK_MOCK.test(source) && !(rel in ALLOWLIST)) {
        offenders.push(rel);
      }
    }

    expect(
      offenders,
      `These specs mock the Temporal SDK without an allowlist entry. Mocking the SDK means ` +
        `the test asserts against a fake whose behavior we invented. Move the test to the ` +
        `"inprocess" tier (real time-skipping server) and assert the effect instead of the call.`,
    ).toEqual([]);
  });

  it("has no stale allowlist entries", async () => {
    const stale: string[] = [];
    for (const rel of Object.keys(ALLOWLIST)) {
      const source = await readFile(join(WORKSPACE_ROOT, rel), "utf8").catch(() => "");
      if (!SDK_MOCK.test(source)) stale.push(rel);
    }

    expect(stale, "Allowlisted specs that no longer mock the SDK — delete these entries.").toEqual(
      [],
    );
  });
});
```

- [ ] **Step 2: Run to verify it passes against the current tree**

Run: `cd packages/testing && pnpm vitest run src/no-sdk-mocks.spec.ts`
Expected: PASS (2 tests). If the first test fails, a spec mocks the SDK that this plan did not inventory — add it to the allowlist with a `TODO` and note it for a follow-up task.

- [ ] **Step 3: Verify the guard actually catches a violation**

Temporarily add `vi.mock("@temporalio/workflow", () => ({}));` to the top of `packages/worker/src/internal.spec.ts` (create a throwaway edit).

Run: `cd packages/testing && pnpm vitest run src/no-sdk-mocks.spec.ts`
Expected: FAIL, naming `packages/worker/src/internal.spec.ts`.

Revert the throwaway edit. **This step is not optional** — a guard that has never been seen to fail is not known to work.

- [ ] **Step 4: Commit**

```bash
git add packages/testing/src/no-sdk-mocks.spec.ts
git commit -m "test(testing): guard against mocking the Temporal SDK"
```

---

### Task 3: Migrate `workflow-proxy.spec.ts` (15 tests)

Done first because it is the purest call-shape case, so it establishes the migration pattern with the least domain noise.

**What it asserts today:** that `proxyActivities` was called with a given `ActivityOptions` (default ⊕ override).
**What it must assert instead:** that an activity actually _runs under_ those options — proven by a `startToCloseTimeout` that really fires.

**Files:**

- Delete: `packages/worker/src/workflow-proxy.spec.ts`
- Create: `packages/worker/src/__tests__/activity-options.contract.ts`
- Create: `packages/worker/src/__tests__/activity-options.workflows.ts`
- Create: `packages/worker/src/__tests__/activity-options.inprocess.spec.ts`
- Modify: `packages/testing/src/no-sdk-mocks.spec.ts` (delete the `workflow-proxy` entry)

**Interfaces:**

- Consumes: `bundleFor`, `withTaskQueue`, `nextTaskQueueId` from Task 1.
- Produces: `activityOptionsContract`, and the reusable in-process harness shape every later migration task copies.

- [ ] **Step 1: Write the contract**

Create `packages/testing/../worker/src/__tests__/activity-options.contract.ts` — exact path `packages/worker/src/__tests__/activity-options.contract.ts`:

```ts
import { defineActivity, defineContract, defineWorkflow } from "@temporal-contract/contract";
import { z } from "zod";

// Composition-first: resources defined individually, then composed.

/**
 * Deliberately tiny `startToCloseTimeout`. The workflow calls this activity
 * with an implementation that outlives the timeout, so a worker that failed
 * to apply the contract-level options would COMPLETE instead of timing out —
 * which is exactly the divergence the old mocked spec could not detect.
 */
const slowActivity = defineActivity({
  input: z.object({ sleepMs: z.number() }),
  output: z.object({ done: z.boolean() }),
  activityOptions: { startToCloseTimeout: "1 second", retry: { maximumAttempts: 1 } },
});

const runsActivity = defineWorkflow({
  input: z.object({ sleepMs: z.number() }),
  output: z.object({ outcome: z.string() }),
  activities: { slowActivity },
});

export const activityOptionsContract = defineContract({
  taskQueue: "activity-options-tests",
  workflows: { runsActivity },
});
```

- [ ] **Step 2: Write the workflow**

Create `packages/worker/src/__tests__/activity-options.workflows.ts`:

```ts
import { declareWorkflow } from "../workflow.js";
import { activityOptionsContract } from "./activity-options.contract.js";

export const runsActivity = declareWorkflow({
  workflowName: "runsActivity",
  contract: activityOptionsContract,
  // No `activityOptions` here — the contract-level options must be what
  // reaches Temporal. That is the property under test.
  implementation: async (context, args) => {
    const result = await context.activities.slowActivity({ sleepMs: args.sleepMs });

    if (result.isDefect()) throw result.cause;
    if (result.isErr()) return { outcome: `err:${result.error.type ?? "unknown"}` };
    return { outcome: "completed" };
  },
});
```

- [ ] **Step 3: Write the failing in-process spec**

Create `packages/worker/src/__tests__/activity-options.inprocess.spec.ts`:

```ts
import { extname } from "node:path";
import { fileURLToPath } from "node:url";

import { TypedClient } from "@temporal-contract/client";
import { it } from "@temporal-contract/testing/time-skipping";
import {
  bundleFor,
  nextTaskQueueId,
  withTaskQueue,
} from "@temporal-contract/testing/workflow-bundle";
import { describe, expect } from "vitest";
import { OkAsync } from "unthrown";

import { declareActivitiesHandler } from "../activity.js";
import { TypedWorker } from "../worker.js";
import { activityOptionsContract } from "./activity-options.contract.js";

function workflowPath(filename: string): string {
  return fileURLToPath(new URL(`./${filename}${extname(import.meta.url)}`, import.meta.url));
}

describe("contract-level activityOptions reach Temporal", () => {
  it("times out an activity that outlives its startToCloseTimeout", async ({ testEnv }) => {
    const contract = withTaskQueue(activityOptionsContract, nextTaskQueueId("activity-options"));
    const bundle = await bundleFor(workflowPath("activity-options.workflows"));

    const activities = declareActivitiesHandler({
      contract,
      activities: {
        runsActivity: {
          // Outlives the 1s startToCloseTimeout. Uses the activity context's
          // real clock, which the time-skipping server advances.
          slowActivity: async ({ sleepMs }) => {
            await new Promise((resolve) => setTimeout(resolve, sleepMs));
            return OkAsync({ done: true });
          },
        },
      },
    });

    const worker = await TypedWorker.create({
      contract,
      connection: testEnv.nativeConnection,
      workflowBundle: bundle,
      activities,
    }).get();

    const client = TypedClient.create({ client: testEnv.client }).for(contract);

    const outcome = await worker.raw.runUntil(async () => {
      const handle = await client.startWorkflow("runsActivity", { sleepMs: 5_000 }).get();
      return handle.result().get();
    });

    // EFFECT assertion: the activity really was cut off by the timeout.
    expect(outcome.outcome).toContain("err:");
  });
});
```

- [ ] **Step 4: Run to verify it fails for the right reason**

Run: `cd packages/worker && pnpm vitest run --project integration-inprocess src/__tests__/activity-options.inprocess.spec.ts`
Expected: FAIL — the workflow/contract files exist but the assertion has never run. Read the failure. If it fails because the test server binary is downloading, re-run; the first run caches it (hence the 120s `testTimeout`).

If it **passes on the first run**, verify the test is real by temporarily raising `startToCloseTimeout` to `"30 seconds"` in the contract — the assertion must then fail. Restore it afterwards.

- [ ] **Step 5: Delete the mocked spec and its allowlist entry**

```bash
git rm packages/worker/src/workflow-proxy.spec.ts
```

In `packages/testing/src/no-sdk-mocks.spec.ts`, delete this line:

```ts
  "packages/worker/src/workflow-proxy.spec.ts": "TODO Task 3",
```

- [ ] **Step 6: Run both suites**

Run: `cd packages/worker && pnpm vitest run --project integration-inprocess`
Expected: PASS

Run: `cd packages/testing && pnpm vitest run src/no-sdk-mocks.spec.ts`
Expected: PASS (both the offender check and the stale-entry check)

- [ ] **Step 7: Commit**

```bash
git add packages/worker/src/__tests__/activity-options.contract.ts \
        packages/worker/src/__tests__/activity-options.workflows.ts \
        packages/worker/src/__tests__/activity-options.inprocess.spec.ts \
        packages/testing/src/no-sdk-mocks.spec.ts
git commit -m "test(worker)!: assert activity options by effect, not by proxyActivities call shape"
```

---

### Task 4: Migrate `handlers.spec.ts` (28 tests)

The highest-value migration. The mocked `setHandler` cannot reproduce Temporal's **update validator slot**, which rejects an update _pre-admission_ — before any history event is written. That is the difference between a cleanly rejected update and a corrupted history.

**Files:**

- Delete: `packages/worker/src/handlers.spec.ts`
- Create: `packages/worker/src/__tests__/handlers.contract.ts`
- Create: `packages/worker/src/__tests__/handlers.workflows.ts`
- Create: `packages/worker/src/__tests__/handlers.inprocess.spec.ts`
- Modify: `packages/testing/src/no-sdk-mocks.spec.ts` (delete the `handlers` entry)

**Interfaces:**

- Consumes: `bundleFor`, `withTaskQueue`, `nextTaskQueueId` (Task 1).
- Produces: `handlersContract` with one signal, one query, one update.

- [ ] **Step 1: Read the spec being replaced and inventory its assertions**

Run: `sed -n '1,80p' packages/worker/src/handlers.spec.ts`

Write down every distinct behavior asserted. The 28 tests collapse into far fewer in-process tests, because many assert the same binding from different angles. **Do not port one-for-one** — port behaviors. Expect roughly 10–14 in-process tests.

Behaviors that MUST survive migration:

1. A signal with a valid payload reaches the handler.
2. A signal with an invalid payload is **dropped and logged**, not fatal to the execution.
3. A query returns its validated output.
4. A query whose input fails validation surfaces `QueryInputValidationError`.
5. An update with a valid payload runs and returns.
6. An update whose input fails validation is **rejected pre-admission** — the client sees a rejection and workflow history is unaffected.
7. An **async** query or update input schema trips `ContractMisuseError` at bind time.

- [ ] **Step 2: Write the contract**

Create `packages/worker/src/__tests__/handlers.contract.ts`:

```ts
import {
  defineContract,
  defineQuery,
  defineSignal,
  defineUpdate,
  defineWorkflow,
} from "@temporal-contract/contract";
import { z } from "zod";

const bump = defineSignal({ input: z.object({ by: z.number().int().positive() }) });

const peek = defineQuery({ output: z.object({ total: z.number() }) });

const applyDelta = defineUpdate({
  input: z.object({ delta: z.number().int().positive() }),
  output: z.object({ total: z.number() }),
});

const counter = defineWorkflow({
  input: z.object({}),
  output: z.object({ total: z.number() }),
  signals: { bump },
  queries: { peek },
  updates: { applyDelta },
});

export const handlersContract = defineContract({
  taskQueue: "handlers-tests",
  workflows: { counter },
});
```

- [ ] **Step 3: Write the workflow**

Create `packages/worker/src/__tests__/handlers.workflows.ts`:

```ts
import { condition } from "@temporalio/workflow";

import { declareWorkflow } from "../workflow.js";
import { handlersContract } from "./handlers.contract.js";

export const counter = declareWorkflow({
  workflowName: "counter",
  contract: handlersContract,
  implementation: async (context) => {
    let total = 0;
    let finished = false;

    context.handleSignal("bump", ({ by }) => {
      total += by;
      // 10 is the agreed terminal value for these tests.
      if (total >= 10) finished = true;
    });

    context.handleQuery("peek", () => ({ total }));

    context.handleUpdate("applyDelta", ({ delta }) => {
      total += delta;
      return { total };
    });

    await condition(() => finished);

    return { total };
  },
});
```

- [ ] **Step 4: Write the in-process spec**

Create `packages/worker/src/__tests__/handlers.inprocess.spec.ts`. Start with the two behaviors that most need real Temporal — signal drop, and update pre-admission rejection:

```ts
import { extname } from "node:path";
import { fileURLToPath } from "node:url";

import { TypedClient } from "@temporal-contract/client";
import { it } from "@temporal-contract/testing/time-skipping";
import {
  bundleFor,
  nextTaskQueueId,
  withTaskQueue,
} from "@temporal-contract/testing/workflow-bundle";
import { describe, expect } from "vitest";

import { TypedWorker } from "../worker.js";
import { handlersContract } from "./handlers.contract.js";

function workflowPath(filename: string): string {
  return fileURLToPath(new URL(`./${filename}${extname(import.meta.url)}`, import.meta.url));
}

describe("handler binding against a real server", () => {
  it("drops an invalid signal without failing the execution", async ({ testEnv }) => {
    const contract = withTaskQueue(handlersContract, nextTaskQueueId("handlers"));
    const bundle = await bundleFor(workflowPath("handlers.workflows"));

    const worker = await TypedWorker.create({
      contract,
      connection: testEnv.nativeConnection,
      workflowBundle: bundle,
    }).get();

    const client = TypedClient.create({ client: testEnv.client }).for(contract);

    const total = await worker.raw.runUntil(async () => {
      const handle = await client.startWorkflow("counter", {}).get();

      // Invalid: `by` must be a positive integer. Must be DROPPED.
      await handle.signal("bump", { by: -1 } as never).get();
      // Valid, and drives the workflow to its terminal value.
      await handle.signal("bump", { by: 10 }).get();

      return handle.result().get();
    });

    // EFFECT: the execution completed, and the bad signal contributed nothing.
    expect(total.total).toBe(10);
  });

  it("rejects an invalid update pre-admission", async ({ testEnv }) => {
    const contract = withTaskQueue(handlersContract, nextTaskQueueId("handlers"));
    const bundle = await bundleFor(workflowPath("handlers.workflows"));

    const worker = await TypedWorker.create({
      contract,
      connection: testEnv.nativeConnection,
      workflowBundle: bundle,
    }).get();

    const client = TypedClient.create({ client: testEnv.client }).for(contract);

    await worker.raw.runUntil(async () => {
      const handle = await client.startWorkflow("counter", {}).get();

      const rejected = await handle.executeUpdate("applyDelta", { delta: -5 } as never);
      expect(rejected.isErr()).toBe(true);

      // EFFECT: the rejected update left no trace — a later query sees zero.
      const peeked = await handle.query("peek").get();
      expect(peeked.total).toBe(0);

      await handle.signal("bump", { by: 10 }).get();
      return handle.result().get();
    });
  });
});
```

Then add the remaining behaviors from Step 1's list, one test each, following the same harness shape.

- [ ] **Step 5: Run and iterate until green**

Run: `cd packages/worker && pnpm vitest run --project integration-inprocess src/__tests__/handlers.inprocess.spec.ts`

The client method names (`executeUpdate`, `query`, `signal`) must match the real typed-client surface — check `packages/client/src/types.ts` if a call does not typecheck. Do **not** add `as any` to force it; fix the call.

- [ ] **Step 6: Verify behavior coverage before deleting**

Re-read the Step 1 behavior list. Each of the 7 items must map to at least one passing in-process test. Anything unmapped stays behind as a gap — port it now, not later.

- [ ] **Step 7: Delete the mocked spec and allowlist entry**

```bash
git rm packages/worker/src/handlers.spec.ts
```

Delete `"packages/worker/src/handlers.spec.ts": "TODO Task 4",` from `no-sdk-mocks.spec.ts`.

- [ ] **Step 8: Run the full worker suite**

Run: `cd packages/worker && pnpm vitest run`
Expected: PASS. Note the new wall-clock time for the final report.

- [ ] **Step 9: Commit**

```bash
git add packages/worker/src/__tests__/handlers.contract.ts \
        packages/worker/src/__tests__/handlers.workflows.ts \
        packages/worker/src/__tests__/handlers.inprocess.spec.ts \
        packages/testing/src/no-sdk-mocks.spec.ts
git commit -m "test(worker)!: exercise signal/query/update binding on a real server"
```

---

### Task 5: Migrate `cancellation.spec.ts` (13 tests)

Real `CancellationScope` propagation, including the swallowed-cancellation hazard where an activity declaring an `errors` map turns a cancel into an absorbable `Err`.

**Files:**

- Delete: `packages/worker/src/cancellation.spec.ts`
- Create: `packages/worker/src/__tests__/cancellation.workflows.ts`
- Create: `packages/worker/src/__tests__/cancellation.inprocess.spec.ts`
- Modify: `packages/testing/src/no-sdk-mocks.spec.ts`

**Interfaces:**

- Consumes: `bundleFor`, `withTaskQueue`, `nextTaskQueueId` (Task 1); `inprocessContract`'s existing `waitForever` workflow as the shape reference.
- Produces: no exports consumed by later tasks.

Behaviors that MUST survive:

1. Cancelling a workflow blocked in a cancellable scope ends the execution **Cancelled**, not Completed.
2. `rethrowCancellation` re-raises a cancellation that a declared-`errors` activity turned into an `Err`.
3. A `nonCancellable` scope runs to completion despite an outer cancel.

- [ ] **Step 1: Write the failing spec for behavior 1**

Create `packages/worker/src/__tests__/cancellation.inprocess.spec.ts`:

```ts
import { extname } from "node:path";
import { fileURLToPath } from "node:url";

import { TypedClient } from "@temporal-contract/client";
import { it } from "@temporal-contract/testing/time-skipping";
import {
  bundleFor,
  nextTaskQueueId,
  withTaskQueue,
} from "@temporal-contract/testing/workflow-bundle";
import { describe, expect } from "vitest";

import { TypedWorker } from "../worker.js";
import { inprocessContract } from "./inprocess.contract.js";

function workflowPath(filename: string): string {
  return fileURLToPath(new URL(`./${filename}${extname(import.meta.url)}`, import.meta.url));
}

describe("cancellation against a real server", () => {
  it("ends the execution Cancelled when a blocked scope is cancelled", async ({ testEnv }) => {
    const contract = withTaskQueue(inprocessContract, nextTaskQueueId("cancellation"));
    const bundle = await bundleFor(workflowPath("inprocess.workflows"));

    const worker = await TypedWorker.create({
      contract,
      connection: testEnv.nativeConnection,
      workflowBundle: bundle,
    }).get();

    const client = TypedClient.create({ client: testEnv.client }).for(contract);

    const outcome = await worker.raw.runUntil(async () => {
      const handle = await client.startWorkflow("waitForever", {}).get();
      await handle.cancel().get();
      return handle.result().get();
    });

    // EFFECT: a real Cancelled outcome, surfaced as the modeled error.
    expect(outcome.isErr()).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails or passes for the right reason**

Run: `cd packages/worker && pnpm vitest run --project integration-inprocess src/__tests__/cancellation.inprocess.spec.ts`

`waitForever` already exists in `inprocess.workflows.ts` and already uses `rethrowCancellation`, so this may pass immediately. That is fine — confirm it is genuinely exercising cancellation by temporarily removing the `rethrowCancellation` call from `inprocess.workflows.ts`; the test must then fail (the execution would Complete instead of Cancel). Restore it.

- [ ] **Step 3: Add behaviors 2 and 3**

Add `cancellation.workflows.ts` with two workflows: one calling a declared-`errors` activity inside a cancellable scope **without** `rethrowCancellation` (proving the hazard), and one wrapping work in `nonCancellable`. Write one test per behavior in the same harness shape as Step 1.

- [ ] **Step 4: Verify all three behaviors pass**

Run: `cd packages/worker && pnpm vitest run --project integration-inprocess src/__tests__/cancellation.inprocess.spec.ts`
Expected: PASS (3+ tests)

- [ ] **Step 5: Delete the mocked spec and allowlist entry**

```bash
git rm packages/worker/src/cancellation.spec.ts
```

Delete `"packages/worker/src/cancellation.spec.ts": "TODO Task 5",` from `no-sdk-mocks.spec.ts`.

- [ ] **Step 6: Commit**

```bash
git add packages/worker/src/__tests__/cancellation.workflows.ts \
        packages/worker/src/__tests__/cancellation.inprocess.spec.ts \
        packages/testing/src/no-sdk-mocks.spec.ts
git commit -m "test(worker)!: exercise cancellation semantics on a real server"
```

---

### Task 6: Migrate `continue-as-new.spec.ts` (10 tests)

Real state carry-over. The mocked `makeContinueAsNewFunc` proved only that a function was called; it could not prove the next run actually receives the carried state.

**Files:**

- Delete: `packages/worker/src/continue-as-new.spec.ts`
- Create: `packages/worker/src/__tests__/continue-as-new.contract.ts`
- Create: `packages/worker/src/__tests__/continue-as-new.workflows.ts`
- Create: `packages/worker/src/__tests__/continue-as-new.inprocess.spec.ts`
- Modify: `packages/testing/src/no-sdk-mocks.spec.ts`

**Interfaces:**

- Consumes: `bundleFor`, `withTaskQueue`, `nextTaskQueueId` (Task 1).
- Produces: `continueAsNewContract`.

Behaviors that MUST survive:

1. A workflow that continues-as-new carries its cursor into the next run and eventually completes with the accumulated value.
2. The **validated target wins** — a smuggled `workflowType` override in the options cannot redirect continue-as-new to a different workflow.

- [ ] **Step 1: Write the contract**

Create `packages/worker/src/__tests__/continue-as-new.contract.ts`:

```ts
import { defineContract, defineWorkflow } from "@temporal-contract/contract";
import { z } from "zod";

const accumulate = defineWorkflow({
  input: z.object({ cursor: z.number(), total: z.number() }),
  output: z.object({ total: z.number() }),
});

export const continueAsNewContract = defineContract({
  taskQueue: "continue-as-new-tests",
  workflows: { accumulate },
});
```

- [ ] **Step 2: Write the workflow**

Create `packages/worker/src/__tests__/continue-as-new.workflows.ts`:

```ts
import { declareWorkflow } from "../workflow.js";
import { continueAsNewContract } from "./continue-as-new.contract.js";

export const accumulate = declareWorkflow({
  workflowName: "accumulate",
  contract: continueAsNewContract,
  implementation: async (context, args) => {
    const total = args.total + args.cursor;

    // Three runs total: cursor 3 → 2 → 1 → done.
    if (args.cursor > 1) {
      await context.continueAsNew({ cursor: args.cursor - 1, total });
    }

    return { total };
  },
});
```

- [ ] **Step 3: Write the failing spec**

Create `packages/worker/src/__tests__/continue-as-new.inprocess.spec.ts`:

```ts
import { extname } from "node:path";
import { fileURLToPath } from "node:url";

import { TypedClient } from "@temporal-contract/client";
import { it } from "@temporal-contract/testing/time-skipping";
import {
  bundleFor,
  nextTaskQueueId,
  withTaskQueue,
} from "@temporal-contract/testing/workflow-bundle";
import { describe, expect } from "vitest";

import { TypedWorker } from "../worker.js";
import { continueAsNewContract } from "./continue-as-new.contract.js";

function workflowPath(filename: string): string {
  return fileURLToPath(new URL(`./${filename}${extname(import.meta.url)}`, import.meta.url));
}

describe("continue-as-new against a real server", () => {
  it("carries accumulated state across runs", async ({ testEnv }) => {
    const contract = withTaskQueue(continueAsNewContract, nextTaskQueueId("continue-as-new"));
    const bundle = await bundleFor(workflowPath("continue-as-new.workflows"));

    const worker = await TypedWorker.create({
      contract,
      connection: testEnv.nativeConnection,
      workflowBundle: bundle,
    }).get();

    const client = TypedClient.create({ client: testEnv.client }).for(contract);

    const result = await worker.raw.runUntil(async () => {
      const handle = await client.startWorkflow("accumulate", { cursor: 3, total: 0 }).get();
      return handle.result().get();
    });

    // EFFECT: 3 + 2 + 1 — proving state really crossed two continue-as-new
    // boundaries, which a mocked makeContinueAsNewFunc could never show.
    expect(result.total).toBe(6);
  });
});
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/worker && pnpm vitest run --project integration-inprocess src/__tests__/continue-as-new.inprocess.spec.ts`
Expected: PASS

Verify the test is real: temporarily change the workflow to pass `total` instead of `total + args.cursor`. The assertion must fail. Restore.

- [ ] **Step 5: Add behavior 2 (validated target wins)**

Add a test that passes a bogus `workflowType` through the continue-as-new options and asserts the next run is still `accumulate` — i.e. the accumulated total still reaches 6 rather than erroring on an unknown workflow type.

- [ ] **Step 6: Delete the mocked spec and allowlist entry**

```bash
git rm packages/worker/src/continue-as-new.spec.ts
```

Delete `"packages/worker/src/continue-as-new.spec.ts": "TODO Task 6",` from `no-sdk-mocks.spec.ts`.

- [ ] **Step 7: Commit**

```bash
git add packages/worker/src/__tests__/continue-as-new.contract.ts \
        packages/worker/src/__tests__/continue-as-new.workflows.ts \
        packages/worker/src/__tests__/continue-as-new.inprocess.spec.ts \
        packages/testing/src/no-sdk-mocks.spec.ts
git commit -m "test(worker)!: prove continue-as-new carries state across runs"
```

---

### Task 7: Migrate `wire-format.spec.ts` (8 tests)

Call-shape assertions over `executeChild` / `startChild`. Replace with real child-workflow executions proving each boundary parses exactly once.

**Files:**

- Delete: `packages/worker/src/wire-format.spec.ts`
- Create: `packages/worker/src/__tests__/child-wire.contract.ts`
- Create: `packages/worker/src/__tests__/child-wire.workflows.ts`
- Create: `packages/worker/src/__tests__/child-wire.inprocess.spec.ts`
- Modify: `packages/testing/src/no-sdk-mocks.spec.ts`

**Interfaces:**

- Consumes: `bundleFor`, `withTaskQueue`, `nextTaskQueueId` (Task 1).
- Produces: `childWireContract`.

Behaviors that MUST survive:

1. A parent workflow starts a child and receives its typed output.
2. A **transforming** schema (`z.coerce` / `.transform`) applies **exactly once** per boundary — the v8 single-parse guarantee.
3. A child signal reaches the child's handler.

- [ ] **Step 1: Write a contract whose schema transforms observably**

Create `packages/worker/src/__tests__/child-wire.contract.ts`. The transform must be **detectable if applied twice** — e.g. an input that appends a marker:

```ts
import { defineContract, defineWorkflow } from "@temporal-contract/contract";
import { z } from "zod";

// Appends "!" once per parse. Two applications yield "x!!" — so a
// double-parse is directly observable in the output.
const markedInput = z.object({ label: z.string().transform((s) => `${s}!`) });

const child = defineWorkflow({
  input: markedInput,
  output: z.object({ label: z.string() }),
});

const parent = defineWorkflow({
  input: z.object({ label: z.string() }),
  output: z.object({ label: z.string() }),
});

export const childWireContract = defineContract({
  taskQueue: "child-wire-tests",
  workflows: { parent, child },
});
```

- [ ] **Step 2: Write the workflows**

Create `packages/worker/src/__tests__/child-wire.workflows.ts`:

```ts
import { declareWorkflow } from "../workflow.js";
import { childWireContract } from "./child-wire.contract.js";

export const child = declareWorkflow({
  workflowName: "child",
  contract: childWireContract,
  implementation: (_context, args) => Promise.resolve({ label: args.label }),
});

export const parent = declareWorkflow({
  workflowName: "parent",
  contract: childWireContract,
  implementation: async (context, args) => {
    const result = await context.executeChild("child", { label: args.label });

    if (result.isDefect()) throw result.cause;
    if (result.isErr()) return { label: "err" };
    return { label: result.value.label };
  },
});
```

- [ ] **Step 3: Write the spec asserting single-parse**

Create `packages/worker/src/__tests__/child-wire.inprocess.spec.ts`:

```ts
import { extname } from "node:path";
import { fileURLToPath } from "node:url";

import { TypedClient } from "@temporal-contract/client";
import { it } from "@temporal-contract/testing/time-skipping";
import {
  bundleFor,
  nextTaskQueueId,
  withTaskQueue,
} from "@temporal-contract/testing/workflow-bundle";
import { describe, expect } from "vitest";

import { TypedWorker } from "../worker.js";
import { childWireContract } from "./child-wire.contract.js";

function workflowPath(filename: string): string {
  return fileURLToPath(new URL(`./${filename}${extname(import.meta.url)}`, import.meta.url));
}

describe("child-workflow wire format", () => {
  it("applies a transforming schema exactly once per boundary", async ({ testEnv }) => {
    const contract = withTaskQueue(childWireContract, nextTaskQueueId("child-wire"));
    const bundle = await bundleFor(workflowPath("child-wire.workflows"));

    const worker = await TypedWorker.create({
      contract,
      connection: testEnv.nativeConnection,
      workflowBundle: bundle,
    }).get();

    const client = TypedClient.create({ client: testEnv.client }).for(contract);

    const result = await worker.raw.runUntil(async () => {
      const handle = await client.startWorkflow("parent", { label: "x" }).get();
      return handle.result().get();
    });

    // EFFECT: exactly one transform application across the boundary.
    // "x!!" would mean the sender parsed AND the receiver re-parsed.
    expect(result.label).toBe("x!");
  });
});
```

- [ ] **Step 4: Run and verify**

Run: `cd packages/worker && pnpm vitest run --project integration-inprocess src/__tests__/child-wire.inprocess.spec.ts`
Expected: PASS with `"x!"`. If it yields `"x!!"`, that is a **real product bug** in the single-parse guarantee — stop and report it rather than adjusting the assertion.

- [ ] **Step 5: Add behaviors 1 and 3**, then delete the mocked spec and its allowlist entry:

```bash
git rm packages/worker/src/wire-format.spec.ts
```

Delete `"packages/worker/src/wire-format.spec.ts": "TODO Task 7",` from `no-sdk-mocks.spec.ts`.

- [ ] **Step 6: Commit**

```bash
git add packages/worker/src/__tests__/child-wire.contract.ts \
        packages/worker/src/__tests__/child-wire.workflows.ts \
        packages/worker/src/__tests__/child-wire.inprocess.spec.ts \
        packages/testing/src/no-sdk-mocks.spec.ts
git commit -m "test(worker)!: prove single-parse across the child-workflow boundary"
```

---

### Task 8: Migrate `workflow-errors.spec.ts` (3 tests)

Call-shape over `proxyActivities`. The real assertion is that a typed contract error raised in an activity **rehydrates** as a `ContractError` inside the calling workflow.

**Files:**

- Delete: `packages/worker/src/workflow-errors.spec.ts`
- Modify: `packages/worker/src/__tests__/rehydration.inprocess.spec.ts` (extend — this file already covers rehydration)
- Modify: `packages/testing/src/no-sdk-mocks.spec.ts`

**Interfaces:**

- Consumes: the existing `rehydration.contract.ts` / `rehydration.workflows.ts` fixtures.
- Produces: nothing.

- [ ] **Step 1: Inventory the 3 assertions**

Run: `cat packages/worker/src/workflow-errors.spec.ts`

Identify which are already covered by `rehydration.inprocess.spec.ts`. Only port genuinely uncovered behavior — do not duplicate.

- [ ] **Step 2: Add any uncovered behavior to `rehydration.inprocess.spec.ts`**

Follow the file's existing harness. Update it to use `bundleFor` from Task 1 if it still bundles per test.

- [ ] **Step 3: Run**

Run: `cd packages/worker && pnpm vitest run --project integration-inprocess src/__tests__/rehydration.inprocess.spec.ts`
Expected: PASS

- [ ] **Step 4: Delete and commit**

```bash
git rm packages/worker/src/workflow-errors.spec.ts
```

Delete `"packages/worker/src/workflow-errors.spec.ts": "TODO Task 8",` from `no-sdk-mocks.spec.ts`.

```bash
git add packages/worker/src/__tests__/rehydration.inprocess.spec.ts \
        packages/testing/src/no-sdk-mocks.spec.ts
git commit -m "test(worker)!: fold workflow-error coverage into the rehydration suite"
```

---

### Task 9: Split `worker.spec.ts` (18 tests)

Config validation and option merging are pure and stay in `unit`. Registration-verification behavior moves to `inprocess`.

**Files:**

- Modify: `packages/worker/src/worker.spec.ts` (strip SDK mocks; keep only pure assertions)
- Modify: `packages/worker/src/__tests__/registration.inprocess.spec.ts` (create if absent)
- Modify: `packages/testing/src/no-sdk-mocks.spec.ts`

**Interfaces:**

- Consumes: existing `registration-*.workflows.ts` fixtures.
- Produces: nothing.

**Critical constraint:** the registration check only runs when `workflowsPath` is passed — prebuilt bundles skip it by design. Registration tests MUST therefore use `workflowsPath`, **not** `bundleFor`. This is the one place in the plan where the bundle cache must not be used.

- [ ] **Step 1: Classify each of the 18 tests**

Run: `grep -n "it(\|test(" packages/worker/src/worker.spec.ts`

For each, decide: does it assert a pure function of the options (stays), or does it assert that Temporal was configured/behaved a certain way (moves)?

- [ ] **Step 2: Move the registration-behavior tests**

Add them to `packages/worker/src/__tests__/registration.inprocess.spec.ts`, calling `TypedWorker.create({ contract, connection, workflowsPath, activities })` — with a real path, no bundle — and asserting the create either succeeds or defects with the registration message.

- [ ] **Step 3: Strip the mocks from the remaining unit tests**

The surviving tests must not need `vi.mock("@temporalio/worker")`. If a test cannot be written without it, it belongs in `inprocess`; move it.

- [ ] **Step 4: Run both projects**

Run: `cd packages/worker && pnpm vitest run`
Expected: PASS

- [ ] **Step 5: Delete the allowlist entry and commit**

Delete `"packages/worker/src/worker.spec.ts": "TODO Task 9",` from `no-sdk-mocks.spec.ts`.

```bash
git add packages/worker/src/worker.spec.ts \
        packages/worker/src/__tests__/registration.inprocess.spec.ts \
        packages/testing/src/no-sdk-mocks.spec.ts
git commit -m "test(worker)!: split worker config tests from registration behavior"
```

---

### Task 10: Nightly mutation testing

Measures whether the surviving tests would **catch** a bug rather than merely execute the line.

**Files:**

- Create: `stryker.config.json`
- Create: `.github/workflows/mutation.yml`
- Modify: `pnpm-workspace.yaml` (catalog entries)
- Modify: `package.json` (script)

**Interfaces:**

- Consumes: the migrated suites from Tasks 3–9.
- Produces: a nightly mutation-score baseline.

- [ ] **Step 1: Add the dependencies to the catalog**

In `pnpm-workspace.yaml`'s `catalog:` block (never per-package):

```yaml
"@stryker-mutator/core": 9.2.0
"@stryker-mutator/vitest-runner": 9.2.0
```

Then at the workspace root: `pnpm add -D -w "@stryker-mutator/core@catalog:" "@stryker-mutator/vitest-runner@catalog:"`

- [ ] **Step 2: Write the config**

Create `stryker.config.json`. Scoped to **pure** modules only — sandboxed workflow paths are excluded because their run cost is prohibitive:

```json
{
  "$schema": "./node_modules/@stryker-mutator/core/schema/stryker-schema.json",
  "packageManager": "pnpm",
  "testRunner": "vitest",
  "vitest": { "project": "unit" },
  "reporters": ["html", "clear-text", "progress"],
  "coverageAnalysis": "perTest",
  "mutate": [
    "packages/contract/src/builder.ts",
    "packages/contract/src/errors-impl.ts",
    "packages/worker/src/contract-errors.ts",
    "packages/worker/src/error-tags.ts",
    "packages/worker/src/internal.ts"
  ],
  "thresholds": { "high": 80, "low": 60, "break": null }
}
```

`"break": null` is deliberate for the first run — this task establishes a **baseline**, and failing the build on an unknown score would be noise. Raising `break` is a follow-up once the number is known.

- [ ] **Step 3: Add the script**

In root `package.json`: `"test:mutation": "stryker run"`

- [ ] **Step 4: Run locally and record the baseline**

Run: `pnpm test:mutation`
Expected: completes and prints a mutation score. **Record the number** — it is the deliverable. A low score is information, not failure: it identifies tests that execute code without asserting on it.

- [ ] **Step 5: Add the nightly workflow**

Create `.github/workflows/mutation.yml` running on `schedule: - cron: "0 3 * * *"` plus `workflow_dispatch`, checking out, installing with pnpm, and running `pnpm test:mutation`. Nightly only — not per-PR.

- [ ] **Step 6: Commit**

```bash
git add stryker.config.json .github/workflows/mutation.yml package.json pnpm-workspace.yaml pnpm-lock.yaml
git commit -m "test: add nightly mutation testing over the pure core modules"
```

---

### Task 11: Final verification

- [ ] **Step 1: Confirm the allowlist contains only the three justified entries**

Run: `grep -c "TODO Task" packages/testing/src/no-sdk-mocks.spec.ts`
Expected: `0`

- [ ] **Step 2: Run the full suite**

Run: `pnpm turbo run typecheck lint test`
Expected: all pass.

- [ ] **Step 3: Run the in-process tier and record wall-clock**

Run: `cd packages/worker && time pnpm vitest run --project integration-inprocess`

Compare against the pre-migration baseline. The spec's success criterion is that per-PR wall-clock does not regress **materially**. If it has, the bundle cache is not being hit — verify `bundleFor` is called with an identical path string across tests (a differing path string silently defeats the cache).

- [ ] **Step 4: Run integration serially**

Docker integration is contention-sensitive; run `turbo run test:integration --concurrency=1`.

- [ ] **Step 5: Commit any fixes and open the PR**

```bash
git push -u origin test/mock-free-architecture
gh pr create --title "test!: mock-free test architecture" --body "Implements docs/superpowers/specs/2026-08-01-mock-free-test-architecture-design.md"
```

---

## Deferred (explicitly out of scope)

- Property-based testing (`fast-check`) — considered during design, deferred.
- Enforced coverage floor — deferred until after migration; a threshold applied to the current suite would lock in false confidence.
- Workstreams 2–4 (determinism invariants, API/type strength, pattern enforcement) — separate specs.
