# Safe-by-default option shapes

**Date:** 2026-08-04
**Status:** Approved
**Scope:** Workstream 4, part 3 of 3, of the production-hardening effort

## Context

`temporal-contract` is in production use where real money depends on it. The
hardening driver is preventive — no incident has occurred.

Shipped so far: mock-free test architecture (PR #359), determinism and
money-safety invariants (PR #360), compile-time contract validation (PR #369),
uniform `AsyncResult` for activity calls (PR #370), and contract-declared
idempotency (PR #371). This is the last of workstream 4's three parts, and the
last item before the 8.0.0 stable cut.

The workstream-4 part-1 spec described this part as _"appears partly satisfied
already; `internal.ts` already requires `activityOptions` once any reachable
activity lacks its own."_ **That assessment was wrong**, and the way it was
wrong is the subject of this spec.

## The problem

### The existing guard is a presence check, not a bound check

`buildRawActivitiesProxy` (`packages/worker/src/internal.ts:118-144`) fails at
declaration time when an activity has no options. Its own comment states the
intent:

> It is still required as soon as any reachable activity has no per-activity
> options of its own; fail at declaration time with the offending names rather
> than letting Temporal's generic "missing timeout" error surface without
> context.

It does not do that. It tests **presence of keys, per source**:

```ts
const hasContractDefaults = contractDefaults && Object.keys(contractDefaults).length > 0;
const hasOverride = override && Object.keys(override).length > 0;
```

Three inputs defeat it:

| Input                                                                    | Guard verdict | Reality               |
| ------------------------------------------------------------------------ | ------------- | --------------------- |
| `defineActivity({ activityOptions: {} })`                                | uncovered ✅  | correct — clean error |
| `defineActivity({ activityOptions: { retry: { maximumAttempts: 3 } } })` | covered       | no timeout            |
| `declareWorkflow({ activityOptions: <anything truthy> })`                | check skipped | no timeout            |

The third is the widest: the whole block is wrapped in `if (!defaultOptions)`,
so **any** truthy `activityOptions` on `declareWorkflow` — including `{}` —
skips the check for every activity.

`internal.spec.ts:29-40` pins only the first row, so the suite is green in all
three cases.

### What happens when it passes vacuously

`proxyActivities` validates at construction (`@temporalio/workflow`
`lib/workflow.js:496-502`, comment: _"Validate as early as possible for
immediate user feedback"_) and throws a plain **`TypeError`**:

```js
if (options.scheduleToCloseTimeout === undefined && options.startToCloseTimeout === undefined) {
  throw new TypeError("Required either scheduleToCloseTimeout or startToCloseTimeout");
}
```

`buildRawActivitiesProxy` runs inside the workflow sandbox, so this is a plain
`Error` thrown from workflow code — the D3 stall this project already fought in
workstream 4 part 1. Temporal retries the **workflow task** indefinitely. The
workflow does not fail; it hangs until its execution timeout, which is itself
unset by default. The consequence is therefore not "a less helpful message", as
the guard's comment implies, but a workflow that never finishes and never
reports why.

The failure fires at workflow start rather than mid-execution, so no partial
side effects occur. That is the one mitigating fact.

### Unbounded retries

`RetryPolicy.maximumAttempts` defaults to **`Infinity`**
(`@temporalio/common/lib/retry-policy.d.ts:21-26`), with backoff capped at 100×
the 1-second initial interval.

`startToCloseTimeout` bounds a **single attempt**, not the sequence. Only
`scheduleToCloseTimeout` bounds the total. So the default posture for an
activity whose failure is not transient — bad credentials, an unmodeled
technical error — is: retry roughly every 100 seconds, forever, inside a
workflow whose `workflowExecutionTimeout` is also unset.

The contract's `nonRetryable` flag does not close this. It applies to
**modeled** domain errors; an unmodeled technical failure becomes a defect and
retries under the default policy.

### Silent child termination

`ParentClosePolicy` defaults to `TERMINATE` — when the parent closes, the child
is killed. Of the 24 child call sites in the repo, **4** set the policy; the
other 20 inherit `TERMINATE` without saying so. A child mid-payment is killed
when its parent closes.

## The design

### Component 1 — a merged-options bound guard

In `buildRawActivitiesProxy`, replace the per-source presence check with a
check on the **merged** options for **every** reachable activity,
unconditionally. The `if (!defaultOptions)` wrapper is removed.

For each activity, with
`M = { ...defaultOptions, ...contractDefaults, ...override }`:

- **R1 — per-attempt bound.** `M.startToCloseTimeout` or
  `M.scheduleToCloseTimeout` must be present.
- **R2 — total bound.** `M.scheduleToCloseTimeout` must be present, **or**
  `M.retry.maximumAttempts` must be a finite positive integer.

A violation of either rule collects the activity name and the rule it broke.
All violations are reported in one `ContractMisuseError` naming every offender.

**Where this actually fires, corrected after implementation.** An earlier draft
of this spec claimed the `ContractMisuseError` — being a non-retryable
`ApplicationFailure` — makes the workflow "fail cleanly instead of stalling."
**That was wrong**, and the correction matters enough to record rather than
quietly edit out.

`declareWorkflow` is called at module top level, so the guard throws while the
workflow bundle's module is being evaluated — before the SDK ever invokes the
workflow function. A throw at that point is caught by `handleActivation`'s
outer catch (`@temporalio/worker` `lib/worker.js:1104-1112`), which produces a
`WorkflowActivationCompletion.failed` **unconditionally**. That is a Workflow
**Task** failure, and `nonRetryable` is inert there — it only has meaning on a
`FailWorkflowExecution` command, which this path never emits. So the guard
stalls the run exactly like the plain `TypeError` it replaced. This was proven
empirically: with the guard mutated off, a real-server run failed
byte-for-byte identically — same timeout tag, same duration.

**Stalling is nevertheless the right behavior, and is kept deliberately.**
Temporal retries workflow tasks precisely so a bug can be fixed and redeployed
with in-flight executions resuming. Making a misconfiguration terminal would
permanently fail every in-flight workflow on a bad deploy, including
mid-payment ones — destroying work that stalling preserves.

The guard's value is therefore **at declaration time in development and CI**,
where it does fire usefully: unit tests exercise it directly, and it is what
drove this change's own fixture migration. It is not a production runtime
safety net, and this document no longer claims it is.

`scheduleToCloseTimeout` satisfies both rules on its own.

**`maximumAttempts` values that are not a bound.** `Infinity` is not — Temporal
drops the field precisely because it is the default
(`retry-policy.js:15-18`). Values `<= 0` and non-integers are not either;
Temporal rejects them with a `ValueError` in `compileRetryPolicy`. The guard's
rule is therefore the positive one: **a finite positive integer is a bound,
everything else is not**. This intentionally lets the library's own message
arrive for the unbounded case, and leaves genuinely invalid values to Temporal's
validation.

**Why merged rather than per-source.** `mergedOptions` spreads `retry`
**shallowly** (`internal.ts:191-195`), so a contract-level
`retry: { initialInterval: "2s" }` replaces `declareWorkflow`'s
`retry: { maximumAttempts: 3 }` wholesale, dropping the bound. Both sources look
bounded in isolation; only the merged result reveals that the bound is gone. A
per-source check cannot see this class of defect at all.

### Component 2 — a required `parentClosePolicy` on child calls

`TypedChildWorkflowOptions` (`packages/worker/src/child-workflow.ts:43-49`)
gains the field as required:

```ts
export type TypedChildWorkflowOptions<
  TChildContract extends ContractDefinition,
  TChildWorkflowName extends keyof TChildContract["workflows"] & string,
> = Omit<ChildWorkflowOptions, "taskQueue" | "args" | "parentClosePolicy"> & {
  args: ClientInferInput<TChildContract["workflows"][TChildWorkflowName]>;
  parentClosePolicy: Exclude<ParentClosePolicy, undefined>;
};
```

`TERMINATE` remains available. It simply has to be chosen rather than inherited.

**The `Exclude` is load-bearing.** The SDK declares

```ts
export type ParentClosePolicy = (typeof ParentClosePolicy)[keyof typeof ParentClosePolicy];
```

and that object contains `PARENT_CLOSE_POLICY_UNSPECIFIED: undefined`
(`@temporalio/workflow/lib/interfaces.d.ts:399-439`). So the union **includes
`undefined`**, and a bare required `parentClosePolicy: ParentClosePolicy` would
still accept `undefined` — a required field that requires nothing. Without the
`Exclude`, this component is a no-op that reads as a fix.

### Why reuse policy moved to the contract but close policy does not

Part 2 moved `workflowIdReusePolicy` onto the contract because _"is this
operation safe to run twice?"_ is a property of the **operation**. `TERMINATE`
vs `REQUEST_CANCEL` vs `ABANDON` is a property of the **parent-child
relationship at this call site** — different parents legitimately want different
answers for the same child. So it stays a call option, and the safety move is to
force the choice rather than relocate it.

## Testing

Per the workstream-1 rule — **assert effects, never call shapes**.

This is a guard whose entire failure mode is passing vacuously, so tests must be
shown to be falsifiable, not merely green:

- **Mutation matrix, required.** Each of these mutations must break a
  **distinct, non-empty** set of tests, and no mutation may leave the suite
  green: (a) drop R1; (b) drop R2; (c) restore the `if (!defaultOptions)`
  bypass; (d) make the retry merge deep instead of shallow.
- **Unit tests** drive `buildRawActivitiesProxy` directly — no workflow
  environment and no SDK mock, as `internal.spec.ts:29-40` already does. One per
  bypass path: retry-only contract bag; truthy-but-timeoutless `declareWorkflow`
  default; override-only; the shallow-merge bound drop; and `maximumAttempts` of
  `Infinity`, `0`, and a non-integer.
- **No in-process effect test — deliberately, after attempting one.** This spec
  originally required a real-server test proving an unbounded activity "fails
  with `ContractMisuseError` rather than hanging." Implementation established
  that it does **not** fail; it stalls (see the correction above). The test was
  built and then discarded because it could not distinguish the two worlds: with
  the guard mutated off, the run failed byte-for-byte identically — same timeout
  tag, same duration. Shipping it would have added a test that passes whether or
  not the feature works, which is precisely the vacuous-guard defect this
  workstream exists to eliminate. The runtime behavior is documented instead.
  The unit tier plus the mutation matrix carry the proof.
- **`parentClosePolicy`** gets type-level tests with `@ts-expect-error` on both
  omission **and** explicit `undefined`. The second is the one that fails if the
  `Exclude` is dropped; without it the component silently reverts to a no-op.

## Migration surface

| Surface                                      | Count                   |
| -------------------------------------------- | ----------------------- |
| Child call sites needing `parentClosePolicy` | 24 (20 currently unset) |
| `activityOptions:` sites in non-spec source  | 30                      |

Plus fixtures across the four packages, and activities that currently have a
per-attempt bound but no total bound — these are found by the type system and
the new guard rather than by grep, and the count is not knowable until the guard
runs.

## What is NOT changing

- Temporal's own defaults. This spec changes what the library **requires an
  author to state**, never what Temporal does with a given value.
- `ContractActivityOptions`' shape. No field becomes required on the contract;
  the rules are satisfiable from any of the three merge sources.
- The merge precedence itself, including the shallow `retry` spread. The guard
  surfaces its consequence rather than changing the semantics — changing them
  would silently alter effective retry policies on upgrade.

## Risks

| Risk                                                                              | Mitigation                                                                                                                               |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| The new guard is itself vacuous — the exact defect it fixes                       | The mutation matrix is a required deliverable, not a suggestion; each mutation must break a distinct non-empty set                       |
| `parentClosePolicy` ships without `Exclude` and requires nothing                  | A dedicated `@ts-expect-error` test on explicit `undefined`, which fails if the `Exclude` is dropped                                     |
| Legitimate long-running activities are forced into an arbitrary bound             | `scheduleToCloseTimeout` satisfies both rules; no value is dictated, only that some bound exists                                         |
| Migration mislabels a fixture, hiding a real gap                                  | Fixtures whose tests assert timeout or retry behavior must keep asserting it; a wrong bound should fail that fixture's own test          |
| A second large breaking change lands in one major, compounding part 2's migration | Both land before the 8.0.0 stable cut, so the client migrates once — this is the stated reason for finishing workstream 4 before the cut |

## Success criteria

1. Every reachable activity has a per-attempt bound and a total bound, enforced
   at declaration time, reported as one `ContractMisuseError` naming each
   offender and the rule it broke.
2. All three bypass paths are closed, each proven by a test that fails when its
   rule is removed.
3. The shallow-merge bound drop is covered by a test.
4. `parentClosePolicy` is required on child calls and rejects explicit
   `undefined`.
5. Examples, docs, and fixtures migrated; `pnpm turbo run typecheck` green
   repo-wide.
6. A changeset records both breaking changes and the migration.
7. The documentation states the guard's **real** runtime behavior — that a
   violation stalls the workflow via workflow-task retry rather than failing it,
   that this is deliberate because it lets a fix-and-redeploy recover in-flight
   executions, and that the guard's value is at declaration time in development
   and CI. No document may claim it fails the workflow cleanly.

## Out of scope

Recorded deliberately, so a later reader knows these were considered rather than
missed:

- **`heartbeatTimeout`.** Without it, a worker crash is undetected until
  `startToCloseTimeout` expires — that timeout _is_ the crash-detection latency.
  A mechanical rule needs a "how long is long" constant the library cannot
  justify and clients would hit on legitimate long-running activities. Not
  enforced and not documented in this scope.
- **A required `workflowExecutionTimeout`.** Would cap total damage, but a
  permanently failing activity would still burn the whole budget before anything
  surfaced. Component 1 localizes the fault instead.
- **`workflowIdConflictPolicy`** as a contract declaration — unchanged from part 2.
