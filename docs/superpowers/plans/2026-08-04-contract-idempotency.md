# Contract-Declared Idempotency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a contract declare, once per workflow, whether that workflow is safe to re-run under the same workflow ID — and have the client apply that declaration to every start, so nobody silently inherits Temporal's `ALLOW_DUPLICATE` default.

**Architecture:** `WorkflowDefinition` gains an `idempotency` field with three named modes that map onto `workflowIdReusePolicy`. The client applies the contract's mode as a **default** at all three start paths, positioned so an explicit per-call policy still wins. The field lands optional first so the repo keeps compiling, and is flipped to required only after every definition declares it.

**Tech Stack:** TypeScript 6.0.3, `@temporalio/*` 1.21.1, unthrown 5.0.0-beta.7, Vitest 4.1.10, `@temporal-contract/testing`'s `testRig` + time-skipping server, pnpm workspaces + turbo, oxlint.

**Spec:** `docs/superpowers/specs/2026-08-04-contract-idempotency-design.md`

## Global Constraints

- **No `any`.** Use `unknown` and narrow. Enforced by oxlint.
- **`.js` extensions in every import.** ESM only.
- **Never edit per-package `package.json` dependency versions** — the `catalog:` block in `pnpm-workspace.yaml` is the only place versions are bumped. This plan adds no dependencies.
- **Assert effects, never call shapes.** A test asserting "we passed `REJECT_DUPLICATE` to Temporal" proves nothing. The invariant is what the _server_ does with a second start.
- **The contract declares reuse; the caller keeps conflict.** `workflowIdConflictPolicy` stays a per-call option and is not touched by this plan.
- **Nothing about Temporal's own deduplication changes.** This plan changes which policy is _sent_, never what the server does with it.
- Conventional Commits are enforced by commitlint on a git hook.

---

## The precedence trap this plan is built around

The contract's `taskQueue` is applied **after** the caller's options spread, so the contract deliberately overrides the caller:

```ts
this.client.workflow.start(workflowName, {
  ...temporalOptions,                    // caller's options
  taskQueue: this.contract.taskQueue,    // contract wins
  args: ...,
});
```

Idempotency needs the **opposite** precedence — before the spread — so a deliberate per-call `workflowIdReusePolicy` is honored:

```ts
this.client.workflow.start(workflowName, {
  workflowIdReusePolicy: reusePolicyFor(definition.idempotency),  // contract default
  ...temporalOptions,                                            // caller overrides
  taskQueue: this.contract.taskQueue,
  args: ...,
});
```

Getting this backwards makes the field impossible to override — a _different_ bug from failing to apply it, and one that a test exercising only the default path cannot catch. Task 2 requires an explicit override test for exactly this reason.

**There are three start paths, not one:** `client.ts:856` (`start`), `client.ts:1003` (`signalWithStart`), `client.ts:1119` (`execute`). A fix applied to only the path the tests happen to cover is the defect shape this project keeps finding.

## Test tiers — verified, the obvious commands do not work

| What you want                     | Command                                                                                             |
| --------------------------------- | --------------------------------------------------------------------------------------------------- |
| Contract unit tests               | `pnpm --filter @temporal-contract/contract test`                                                    |
| Client unit tests                 | `pnpm --filter @temporal-contract/client test`                                                      |
| Worker unit tests                 | `pnpm --filter @temporal-contract/worker test`                                                      |
| **In-process tier (real server)** | `pnpm --filter @temporal-contract/worker exec vitest run --project integration-inprocess <pattern>` |

`pnpm --filter <pkg> test` runs **only** the `unit` project, and a filename after `--` does **not** filter. The client package has no in-process tier at all — `testRig` lives in the worker package and returns both a worker and a client, which is why the effect proof in Task 3 lives there.

Every `*.inprocess.spec.ts` must call `testRig(` — a corpus guard in `packages/testing/src/inprocess-specs-use-rig.spec.ts` enforces it.

---

## File Structure

| File                                                                               | Responsibility                                                                                      |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `packages/contract/src/types.ts`                                                   | **Modify.** Add `IdempotencyMode` and the `idempotency` field on `WorkflowDefinition`.              |
| `packages/contract/src/idempotency.ts`                                             | **Create.** `reusePolicyFor()` — the single mode→policy mapping, so client and worker cannot drift. |
| `packages/contract/src/idempotency.spec.ts`                                        | **Create.** Unit tests for the mapping.                                                             |
| `packages/contract/src/builder.ts`                                                 | **Modify.** Runtime validation of the field in `validateWorkflowDefinition`.                        |
| `packages/client/src/client.ts`                                                    | **Modify.** Apply the default at all three start paths.                                             |
| `packages/worker/src/child-workflow.ts`                                            | **Modify.** Same for child workflows.                                                               |
| `packages/worker/src/__tests__/idempotency.{contract,workflows,inprocess.spec}.ts` | **Create.** The effect proof.                                                                       |

## Sequencing rationale

The field is **optional** through Tasks 1-4 so the repo keeps compiling and each behavioral change is verifiable in isolation. Task 5 migrates every definition and _then_ flips it to required — so the constraint bites only once the migration is proven, rather than breaking 97 call sites before any behavior exists.

---

### Task 1: The mode, the mapping, and runtime validation

**Files:**

- Modify: `packages/contract/src/types.ts`
- Create: `packages/contract/src/idempotency.ts`
- Create: `packages/contract/src/idempotency.spec.ts`
- Modify: `packages/contract/src/builder.ts`
- Modify: `packages/contract/src/index.ts`

**Interfaces:**

- Consumes: nothing.
- Produces:
  - `type IdempotencyMode = "once-per-id" | "retry-if-failed" | "allow-duplicate"`
  - `function reusePolicyFor(mode: IdempotencyMode): WorkflowIdReusePolicy`
  - `WorkflowDefinition` gains `readonly idempotency?: IdempotencyMode` (optional for now; Task 5 makes it required)

- [ ] **Step 1: Write the failing test**

Create `packages/contract/src/idempotency.spec.ts`:

```ts
import { describe, expect, it } from "vitest";

import { reusePolicyFor } from "./idempotency.js";

describe("reusePolicyFor", () => {
  it("maps once-per-id to REJECT_DUPLICATE — the ID may run exactly once, ever", () => {
    expect(reusePolicyFor("once-per-id")).toBe("REJECT_DUPLICATE");
  });

  it("maps retry-if-failed to ALLOW_DUPLICATE_FAILED_ONLY — re-runnable only after a non-success", () => {
    expect(reusePolicyFor("retry-if-failed")).toBe("ALLOW_DUPLICATE_FAILED_ONLY");
  });

  it("maps allow-duplicate to ALLOW_DUPLICATE — Temporal's default, chosen deliberately", () => {
    expect(reusePolicyFor("allow-duplicate")).toBe("ALLOW_DUPLICATE");
  });

  it("maps every declared mode — a new mode without a mapping is a compile error", () => {
    // `Record<IdempotencyMode, …>` in the implementation makes an unmapped
    // mode fail to compile. This test pins the runtime side: every mode
    // produces a policy string, none produces undefined.
    const modes = ["once-per-id", "retry-if-failed", "allow-duplicate"] as const;
    for (const mode of modes) {
      expect(typeof reusePolicyFor(mode)).toBe("string");
    }
  });
});
```

- [ ] **Step 2: Run it and verify it fails**

```bash
pnpm --filter @temporal-contract/contract test
```

Expected: failure reporting `Cannot find module './idempotency.js'`.

- [ ] **Step 3: Implement the mapping**

Create `packages/contract/src/idempotency.ts`:

```ts
/**
 * How a workflow behaves when started again with a workflow ID that has
 * already been used.
 *
 * Named for the *intent* rather than Temporal's enum, which names the
 * mechanism: a reader of `"retry-if-failed"` knows what is protected, where
 * `ALLOW_DUPLICATE_FAILED_ONLY` has to be decoded.
 *
 * This governs the **Closed**-run case only (`workflowIdReusePolicy`). What
 * happens against a *Running* run is `workflowIdConflictPolicy`, which stays
 * a per-call option because different callers legitimately want different
 * answers to "one is already in flight".
 */
export type IdempotencyMode =
  /** This workflow ID may run exactly once, ever. */
  | "once-per-id"
  /** Re-runnable only if the previous attempt did not succeed. */
  | "retry-if-failed"
  /** Temporal's own default. Re-runnable after any Closed state, including Completed. */
  | "allow-duplicate";

/**
 * Temporal's `workflowIdReusePolicy` values, inlined rather than imported.
 *
 * The contract package deliberately carries no `@temporalio/*` dependency —
 * see `DurationValue`'s comment in `types.ts` for the same rationale. The
 * client and worker pass these strings straight through to the SDK, which
 * accepts exactly these literals.
 */
export type WorkflowIdReusePolicy =
  "ALLOW_DUPLICATE" | "ALLOW_DUPLICATE_FAILED_ONLY" | "REJECT_DUPLICATE";

/**
 * The single mode→policy mapping. Client and worker both call this so the two
 * cannot drift; `Record<IdempotencyMode, …>` makes a newly added mode a
 * compile error until it is mapped.
 */
const REUSE_POLICY: Record<IdempotencyMode, WorkflowIdReusePolicy> = {
  "once-per-id": "REJECT_DUPLICATE",
  "retry-if-failed": "ALLOW_DUPLICATE_FAILED_ONLY",
  "allow-duplicate": "ALLOW_DUPLICATE",
};

/** Translate a contract's declared idempotency mode to Temporal's policy. */
export function reusePolicyFor(mode: IdempotencyMode): WorkflowIdReusePolicy {
  return REUSE_POLICY[mode];
}
```

- [ ] **Step 4: Add the field to `WorkflowDefinition`**

In `packages/contract/src/types.ts`, import the mode:

```ts
import type { IdempotencyMode } from "./idempotency.js";
```

and add to the `WorkflowDefinition` object body (after `output`):

```ts
  /**
   * Whether this workflow is safe to re-run under a workflow ID that has
   * already been used. Applied by the client to every start of this
   * workflow; an explicit per-call `workflowIdReusePolicy` still wins.
   *
   * Optional during migration — becomes required, so that the question is
   * asked once per workflow rather than silently inheriting Temporal's
   * `ALLOW_DUPLICATE`.
   */
  readonly idempotency?: IdempotencyMode;
```

- [ ] **Step 5: Add runtime validation**

In `packages/contract/src/builder.ts`, inside `validateWorkflowDefinition` (after the `output` schema assertion), add:

```ts
const idempotency = definition["idempotency"];
if (
  idempotency !== undefined &&
  idempotency !== "once-per-id" &&
  idempotency !== "retry-if-failed" &&
  idempotency !== "allow-duplicate"
) {
  fail(`${context}: idempotency must be "once-per-id", "retry-if-failed", or "allow-duplicate"`);
}
```

This defends JavaScript callers and `as never` escapes, exactly as the other 31 `fail()` sites do.

- [ ] **Step 6: Export the public surface**

In `packages/contract/src/index.ts`, add `IdempotencyMode` and `reusePolicyFor` to the exports, following the file's existing style. Check whether `packages/contract/src/internal.ts` is the better home for `reusePolicyFor` by looking at how other cross-package helpers are exposed — if the client and worker import it from `/internal` elsewhere, match that.

- [ ] **Step 7: Verify and commit**

```bash
pnpm --filter @temporal-contract/contract test
pnpm --filter @temporal-contract/contract typecheck
pnpm lint
git add packages/contract/src/
git commit -m "feat(contract): add idempotency mode and reuse-policy mapping"
```

---

### Task 2: The client applies it, at all three start paths

**Files:**

- Modify: `packages/client/src/client.ts` (three sites: ~856, ~1003, ~1119)
- Modify: `packages/client/src/client.spec.ts`

**Interfaces:**

- Consumes: `reusePolicyFor(mode)` and `IdempotencyMode` from Task 1.
- Produces: contract-declared idempotency applied on `startWorkflow`, `signalWithStart`, and `executeWorkflow`.

**The precedence requirement, restated because it is the whole point of this task.** The contract's policy goes **before** the caller's spread; `taskQueue` stays after. If you place it after, the field becomes un-overridable and the default-path test still passes.

- [ ] **Step 1: Write the failing tests**

Add to `packages/client/src/client.spec.ts`. Read the file first and follow its existing setup for building a client and capturing what was passed to the underlying Temporal client — reuse that harness rather than inventing one.

```ts
describe("contract-declared idempotency", () => {
  it("applies the contract's mode as workflowIdReusePolicy on startWorkflow", async () => {
    // Contract declares "once-per-id"; the caller sets no policy.
    // Expect REJECT_DUPLICATE to reach the Temporal client.
  });

  it("applies it on signalWithStart", async () => {
    // Same, through the signalWithStart path.
  });

  it("applies it on executeWorkflow", async () => {
    // Same, through the executeWorkflow path.
  });

  it("lets an explicit per-call workflowIdReusePolicy override the contract", async () => {
    // Contract declares "once-per-id"; caller passes ALLOW_DUPLICATE.
    // Expect ALLOW_DUPLICATE — this is the test that catches a
    // contract-after-spread mistake, which the three tests above cannot.
  });

  it("sends no policy when the contract declares none", async () => {
    // During migration `idempotency` is optional. A contract without it must
    // behave exactly as before — no workflowIdReusePolicy on the wire — so
    // this change is inert until a contract opts in.
  });
});
```

Fill in each body using the file's existing assertion style. **These are call-shape assertions, and that is correct here**: this task is about which option is constructed. The _behavioral_ proof is Task 3, on a real server. Both are needed; neither substitutes for the other.

- [ ] **Step 2: Run and verify they fail**

```bash
pnpm --filter @temporal-contract/client test
```

Expected: the four "applies"/"override" tests fail; the "sends no policy" test passes already.

- [ ] **Step 3: Apply at all three sites**

At each of `client.ts:856` (`workflow.start`), `client.ts:1003` (`workflow.signalWithStart`), and `client.ts:1119` (`workflow.execute`), add the contract default **before** the spread:

```ts
            ...(definition.idempotency
              ? { workflowIdReusePolicy: reusePolicyFor(definition.idempotency) }
              : {}),
            ...temporalOptions,
            taskQueue: this.contract.taskQueue,
```

The conditional spread matters: emitting `workflowIdReusePolicy: undefined` explicitly would differ from omitting it under `exactOptionalPropertyTypes`, and would change behavior for contracts that declare nothing.

`definition` is already in scope at each site — it comes from `resolveDefinitionAndValidateInput`. If it is not, get it from there rather than re-resolving.

- [ ] **Step 4: Verify**

```bash
pnpm --filter @temporal-contract/client test
pnpm --filter @temporal-contract/client typecheck
```

Expected: all pass.

- [ ] **Step 5: Prove the override test discriminates**

Move the contract default from before the spread to **after** it, at one site. Re-run. Expected: the override test **fails** while the three "applies" tests still pass — demonstrating that only the override test catches this. Restore, re-run, confirm green. Paste both runs into your report.

- [ ] **Step 6: Commit**

```bash
pnpm lint
git add packages/client/src/
git commit -m "feat(client): apply contract-declared idempotency to every start path"
```

---

### Task 3: Prove it by effect on a real server

**Files:**

- Create: `packages/worker/src/__tests__/idempotency.contract.ts`
- Create: `packages/worker/src/__tests__/idempotency.workflows.ts`
- Create: `packages/worker/src/__tests__/idempotency.inprocess.spec.ts`

**Interfaces:**

- Consumes: the client behavior from Task 2.
- Produces: the behavioral proof that deduplication actually happens.

**Why this task exists.** Task 2 proved the option is _constructed_. This proves the server _deduplicates_. Per the workstream-1 rule, the second is the one that matters — a test asserting "we passed `REJECT_DUPLICATE`" would survive the option being dropped between the client and Temporal.

- [ ] **Step 1: Write the contract fixture**

Create `packages/worker/src/__tests__/idempotency.contract.ts` with three workflows — one per mode — each taking a `{ shouldFail: boolean }` input and returning `{ ok: boolean }`, so the same fixture can produce both a completed and a failed run. Model it on `packages/worker/src/__tests__/retry.contract.ts`, which is the house style. Give the contract `taskQueue: "idempotency-tests"`.

- [ ] **Step 2: Write the workflow fixtures**

Create `packages/worker/src/__tests__/idempotency.workflows.ts`. Each implementation returns `{ ok: true }` when `shouldFail` is false, and fails the workflow when true. To fail it, throw an `ApplicationFailure` — a `TemporalFailure`, so Temporal records the run as **Failed** rather than looping on a workflow-task retry. Model the failure shape on how the repo's other fixtures fail a workflow deliberately.

- [ ] **Step 3: Write the effect spec**

Create `packages/worker/src/__tests__/idempotency.inprocess.spec.ts`, using `testRig` (required — a corpus guard enforces it). Five tests:

1. **`once-per-id` rejects a second start after success.** Start with a fixed `workflowId`, await completion, start again with the same ID → the second start must be an `Err`. Assert on the error's identity, not merely that it is an `Err`.
2. **`retry-if-failed` rejects after a _successful_ run.** Same shape, `shouldFail: false`.
3. **`retry-if-failed` allows a second start after a _failed_ run.** `shouldFail: true`, await the failure, start again → **succeeds**. Tests 2 and 3 together are what distinguish this mode; either alone would pass for the wrong reason.
4. **`allow-duplicate` allows a second start after success.**
5. **An explicit per-call `ALLOW_DUPLICATE` overrides a `once-per-id` contract** → the second start succeeds.

Use a distinct `nextTaskQueueId(...)` per test, as the other in-process specs do, so runs cannot collide.

- [ ] **Step 4: Run and verify**

```bash
pnpm --filter @temporal-contract/worker exec vitest run --project integration-inprocess idempotency
```

Expected: 5/5 pass.

If a test **hangs** rather than failing, the workflow is in a workflow-task retry loop — the failure fixture is throwing a non-`TemporalFailure`. Set a short `workflowExecutionTimeout` on the starts so this surfaces fast, and fix the fixture rather than raising the timeout.

- [ ] **Step 5: Prove the suite discriminates**

Temporarily change `reusePolicyFor` so every mode returns `"ALLOW_DUPLICATE"`. Re-run. Expected: tests 1, 2 fail (second starts now succeed); tests 3, 4, 5 still pass. Restore and confirm 5/5. Paste both runs — a dedup suite that passes with dedup disabled proves nothing.

- [ ] **Step 6: Commit**

```bash
pnpm --filter @temporal-contract/worker typecheck
pnpm lint
git add packages/worker/src/__tests__/idempotency.*
git commit -m "test(worker): prove contract idempotency by effect on the real server"
```

---

### Task 4: Child workflows honor the declared mode

**Files:**

- Modify: `packages/worker/src/child-workflow.ts`
- Modify: the worker spec covering child workflows (find it with `grep -rln "startChild\|executeChild" packages/worker/src`)

**Interfaces:**

- Consumes: `reusePolicyFor` from Task 1.
- Produces: the declared mode applied to child-workflow starts.

- [ ] **Step 1: Find the child start path**

```bash
grep -n "startChild\|executeChild\|ChildWorkflowOptions" packages/worker/src/child-workflow.ts
```

Read `TypedChildWorkflowOptions` at `child-workflow.ts:40` and the call sites it feeds.

- [ ] **Step 2: Write the failing test**

Add a unit test asserting that starting a child of a workflow whose contract declares `"once-per-id"` passes `workflowIdReusePolicy: "REJECT_DUPLICATE"`, and that an explicit per-call policy overrides it. Follow the existing child-workflow spec's harness.

- [ ] **Step 3: Apply the default with the same precedence**

Contract default **before** the caller's spread, exactly as in Task 2. Use the same conditional-spread form so a contract without a declaration emits nothing.

- [ ] **Step 4: Verify**

```bash
pnpm --filter @temporal-contract/worker test
pnpm --filter @temporal-contract/worker typecheck
```

- [ ] **Step 5: Commit**

```bash
pnpm lint
git add packages/worker/src/
git commit -m "feat(worker): apply contract idempotency to child workflows"
```

---

### Task 5: Migrate every definition, then make the field required

**Files:**

- Modify: every workflow definition across `packages/`, `examples/` (97 `defineWorkflow(` call sites plus inline definitions in `workflows: { … }` blocks)
- Modify: `packages/contract/src/types.ts` (flip `idempotency?:` to `idempotency:`)

**Interfaces:**

- Consumes: `IdempotencyMode` from Task 1.
- Produces: a repo where every workflow declares its mode and omission is a compile error.

**Framing.** This is the largest, most mechanical task, and the one where a wrong choice is invisible. Two rules:

- **Default to `"allow-duplicate"` for test fixtures and read-only workflows.** It is Temporal's existing behavior, so it preserves what every current test asserts. Choosing a stricter mode for a fixture could change what its test proves.
- **Do not** apply a stricter mode to a fixture just because it looks money-ish. If a fixture's test asserts deduplication, it belongs in Task 3's suite, not here.

For the **examples**, choose deliberately — they are teaching material. A payment or order workflow should demonstrate `"retry-if-failed"` or `"once-per-id"`, and say why in a comment.

- [ ] **Step 1: Inventory**

```bash
grep -rn 'defineWorkflow(' packages/*/src examples/*/src --include='*.ts' | wc -l
pnpm turbo run typecheck 2>&1 | tee /tmp/idem-before.txt
```

Record the count and the current state (green) before changing anything.

- [ ] **Step 2: Migrate every definition**

Add `idempotency` to each. Work package by package and keep a list.

- [ ] **Step 3: Flip the field to required**

In `packages/contract/src/types.ts`, change `readonly idempotency?: IdempotencyMode;` to `readonly idempotency: IdempotencyMode;` and update the doc comment — drop the "optional during migration" sentence.

- [ ] **Step 4: Verify nothing was missed**

```bash
pnpm turbo run typecheck
```

Expected: green. Any error names a definition you missed — fix it rather than relaxing the type.

- [ ] **Step 5: Verify no test changed meaning**

```bash
pnpm turbo run test
pnpm --filter @temporal-contract/worker exec vitest run --project integration-inprocess
```

Expected: all green, with the **same** counts as before your change. Report the before/after counts. A test that now passes for a different reason is the failure mode here.

- [ ] **Step 6: Commit**

```bash
pnpm lint
git add -A
git commit -m "feat(contract)!: require an idempotency declaration on every workflow"
```

---

### Task 6: Documentation and changeset

**Files:**

- Modify: docs containing `defineWorkflow(` (19 files — find with `grep -rln 'defineWorkflow(' docs/ | grep -v '/api/'`)
- Create: `.changeset/contract-idempotency.md`

- [ ] **Step 1: Migrate the doc examples**

Every `defineWorkflow(` snippet needs the field. **Compile the ones you change** — extract them to a scratch file outside the repo and typecheck against the real package. Doc snippets verified by reading rather than compiling have shipped broken on this project four times.

- [ ] **Step 2: Document the feature**

Add a section to `docs/how-to/define-a-contract.md` covering: the three modes, why the split between contract-declared reuse and per-call conflict, and that Temporal's default permits re-running a **successfully completed** workflow. Include the `charge-${orderId}` double-charge example — it is what makes the stakes concrete.

- [ ] **Step 3: Add an upgrade-guide section**

`docs/how-to/upgrade-to-v8.md` — a required field is a breaking change every consumer hits. State the three modes, that `"allow-duplicate"` preserves existing behavior exactly, and that a migration wanting no behavior change should use it everywhere and revisit deliberately.

- [ ] **Step 4: Write the changeset**

Create `.changeset/contract-idempotency.md`:

````markdown
---
"@temporal-contract/contract": major
---

Workflows must now declare an `idempotency` mode, and the client applies it to
every start.

Temporal's `workflowIdReusePolicy` defaults to `ALLOW_DUPLICATE`, which permits
starting a new run when a previous run with the same workflow ID has **closed —
including completing successfully**. For a workflow keyed `charge-${orderId}`, a
retried start after a successful charge starts a second charge.

Declare the intent once, on the contract:

```ts
defineWorkflow({
  input,
  output,
  idempotency: "retry-if-failed", // re-runnable only if the last attempt failed
});
```
````

| Mode                | Temporal policy               | Meaning                                                  |
| ------------------- | ----------------------------- | -------------------------------------------------------- |
| `"once-per-id"`     | `REJECT_DUPLICATE`            | this workflow ID may run exactly once, ever              |
| `"retry-if-failed"` | `ALLOW_DUPLICATE_FAILED_ONLY` | re-runnable only if the previous attempt did not succeed |
| `"allow-duplicate"` | `ALLOW_DUPLICATE`             | Temporal's previous default                              |

**Breaking:** the field is required. Existing workflows keep their exact current
behavior with `"allow-duplicate"` — but the field is required precisely so the
question gets asked once per workflow rather than inherited silently.

`workflowIdConflictPolicy` is unchanged and remains a per-call option: whether
re-running is safe is a property of the operation, while what to do about a run
already in flight is a property of the call. An explicit per-call
`workflowIdReusePolicy` still overrides the contract's mode.

````

- [ ] **Step 5: Full verification**

```bash
pnpm turbo run typecheck
pnpm turbo run test
pnpm --filter @temporal-contract/worker exec vitest run --project integration-inprocess
pnpm lint
pnpm knip
pnpm changeset status
````

All green; `changeset status` must list the new changeset.

- [ ] **Step 6: Commit**

```bash
git add docs .changeset
git commit -m "docs: document contract-declared idempotency"
```

---

## Self-Review

**1. Spec coverage.**

| Spec requirement                                    | Task                         |
| --------------------------------------------------- | ---------------------------- |
| Three named modes mapping to reuse policies         | Task 1                       |
| Required field, omission a compile error            | Task 5 Step 3                |
| Runtime validation for JS callers                   | Task 1 Step 5                |
| Applied on all three client start paths             | Task 2 Step 3                |
| Caller override wins (precedence before the spread) | Task 2 Steps 3 and 5         |
| Child workflows honor it                            | Task 4                       |
| Each mode proven by effect                          | Task 3 Steps 3-4             |
| Both directions of `retry-if-failed`                | Task 3 Step 3, tests 2 and 3 |
| Override proven by effect                           | Task 3 Step 3, test 5        |
| Migration of examples, fixtures, docs               | Tasks 5 and 6                |
| Changeset records the breaking change               | Task 6 Step 4                |
| `workflowIdConflictPolicy` untouched                | Global Constraints           |

No gaps.

**2. Placeholder scan.** Tasks 2, 3, and 4 describe test _bodies_ in prose rather than verbatim code, because each must reuse the harness already in its target spec file — `client.spec.ts` and the child-workflow spec have established setups, and inventing a parallel one would be worse than fitting in. Each such step names the file to model on and states exactly what must be asserted. Task 5's edits cannot be enumerated because the set of definitions is only knowable by grep at execution time; it specifies the decision rule and the anti-weakening check instead.

**3. Type consistency.** `IdempotencyMode`, `reusePolicyFor`, `WorkflowIdReusePolicy`, and the field name `idempotency` are used identically at every definition and reference.

**Two risks the plan cannot eliminate:**

- **`testRig` and rejected starts.** The rig proxies `ContractClient` and harvests histories for replay. Task 3 deliberately makes second starts _fail_, which may interact with `extractStartedWorkflowId` or the replay harvest in ways no existing spec exercises. If the rig errors on a rejected start, that is a finding about the rig, not a reason to weaken the test — report it.
- **`signalWithStart` semantics.** It may not honor `workflowIdReusePolicy` identically to `start`, since its whole purpose is to attach-or-create. Task 2 asserts the option is constructed; if Task 3 or a later effect test shows the server behaves differently there, document the divergence rather than hiding it.
