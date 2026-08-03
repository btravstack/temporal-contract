# Uniform `AsyncResult` for activity calls

**Date:** 2026-08-04
**Status:** Approved
**Scope:** Workstream 4 of the production-hardening effort, part 1 of 3

## Context

`temporal-contract` is in production use where real money depends on it. The
hardening driver is preventive — no incident has occurred.

Workstreams 1-3 shipped: mock-free test architecture (PR #359), determinism and
money-safety invariants (PR #360), compile-time contract validation (PR #369).
Workstream 4 is **pattern enforcement** — API shapes that force correct usage —
and splits into three independent pieces:

1. **The bimodal activity proxy** (this spec)
2. Idempotency / deduplication guidance — `workflowIdReusePolicy` and
   `workflowIdConflictPolicy` are currently unguided passthrough
3. Safe-by-default option shapes — appears partly satisfied already;
   `internal.ts` already requires `activityOptions` once any reachable activity
   lacks its own

Each gets its own spec → plan → implementation cycle.

## The problem

`WorkflowInferActivity` (`packages/worker/src/activities-proxy.ts:51-60`)
switches the workflow-side call contract on whether the contract declared an
`errors` map:

```ts
export type WorkflowInferActivity<TActivity extends ActivityDefinition> = TActivity extends {
  errors: infer TErrors extends Record<string, ErrorDefinition>;
}
  ? (
      args: ClientInferInput<TActivity>,
    ) => AsyncResult<
      ClientInferOutput<TActivity>,
      ContractErrorUnion<TErrors> | ActivityError | ActivityCancelledError
    >
  : (args: ClientInferInput<TActivity>) => Promise<ClientInferOutput<TActivity>>;
```

with the runtime counterpart at `activities-proxy.ts:141-143` choosing
`makeResultShapedActivity` or `makeThrowingActivity`.

Two consequences:

- **The call site cannot tell you which contract applies.** `await
context.activities.charge(x)` is either a value that throws on failure or an
  `AsyncResult` that never throws, decided by a declaration in a different file.
- **The throwing branch violates the project's own rule 2** (`AGENTS.md`):
  _"Activities and the typed client return `AsyncResult<T, E>` from unthrown.
  Never throw."_

This is not a typing bug — the types are accurate. It is a predictability
defect, and it is not hypothetical: it caught the library's own author during
workstream 2 planning, where sample code narrowed the call as an `AsyncResult`
against an activity that declared no `errors` map and would have thrown a
`TypeError` at runtime.

## The design

### Uniform return shape

`WorkflowInferActivity` loses its conditional. Every activity returns an
`AsyncResult`:

```ts
export type WorkflowInferActivity<TActivity extends ActivityDefinition> = (
  args: ClientInferInput<TActivity>,
) => AsyncResult<ClientInferOutput<TActivity>, ActivityErrorsFor<TActivity>>;
```

where `ActivityErrorsFor<TActivity>` is
`ContractErrorUnion<TErrors> | ActivityError | ActivityCancelledError` when the
activity declares errors, and `ActivityError | ActivityCancelledError` when it
does not. The error _channel_ still varies with the contract — that is correct
and useful — but the _call convention_ no longer does.

`makeThrowingActivity` is deleted. Every activity flows through
`makeResultShapedActivity`.

### Propagation must preserve Temporal's failure semantics

**This is the highest-risk part of the change and the reason it is not a
mechanical refactor.**

Today, an activity without declared errors lets Temporal's original
`ActivityFailure` propagate out of the workflow. `ActivityFailure` and
`ApplicationFailure` both extend `TemporalFailure`
(`@temporalio/common/lib/failure.d.ts:71,108,219`), and Temporal's handling of a
workflow-code exception depends on that lineage.

`ActivityError` is **not** a `TemporalFailure` — it is a `TaggedError`
(`packages/worker/src/errors.ts:322`). So a caller who "just rethrows" the
`Err` value is not reproducing today's behavior, and unthrown's own
`.getOrThrow()` is the wrong tool: it throws the `ActivityError` wrapper.

`classifyActivityError` (`activities-proxy.ts`) already preserves the unwrapped
inner failure as `ActivityError`'s `cause`. The library therefore provides an
explicit propagation helper that rethrows **that preserved cause**, so Temporal
observes exactly the failure it observes today.

Naming and exact signature are an implementation decision for the plan, but the
helper must be **named and documented in the public API** rather than left to
callers to reconstruct — reconstructing it wrongly is a silent change in
workflow failure classification.

**The behavioral claim must be proven, not asserted.** The plan must
demonstrate by effect, on the real time-skipping test server, that for an
activity without declared errors the **workflow status and attempt count are
identical before and after this change** — both when the failure propagates and
when it is handled. Asserting merely that "an error was thrown" would not catch
a reclassification from workflow-failure to workflow-task-failure, which is the
exact defect this section exists to prevent.

This mirrors workstream 2's governing lesson: restoring a property is not
proving a behavior.

### Cancellation keeps its existing warning

`errors.ts:343-347` already documents that swallowing `ActivityCancelledError`
makes a workflow complete as `Completed` instead of `Cancelled`. That hazard now
applies to **every** activity rather than only errors-declaring ones, so the
warning must be surfaced correspondingly more prominently in the docs.

## Blast radius

Measured on the current branch:

| Surface                                        | Count              |
| ---------------------------------------------- | ------------------ |
| `defineActivity` declarations in `examples/`   | 7                  |
| `activities.` call sites in `examples/`        | 11                 |
| `activities.` call sites in `packages/worker/` | ~71 (mostly tests) |
| Doc files referencing `activities.`            | ~107               |

Documentation dominates. The core library change is small; the migration is
wide.

## What is NOT changing

- The client-side API. This spec covers the **workflow-side** activity proxy
  only.
- Error classification itself — `classifyActivityError`, contract-error
  rehydration, and the cancellation discriminant all keep their current
  behavior.
- Input/output validation, and the validate-on-send / parse-on-receive wire
  contract.
- Any runtime validation in `defineContract`.

## Risks

| Risk                                                                                                                                                 | Mitigation                                                                                                                                                     |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rethrowing the wrong error changes Temporal's failure classification — a workflow that should fail terminally instead retries forever, or vice versa | The propagation helper rethrows the preserved original cause; proven by effect against workflow status and attempt count on the real test server, before/after |
| Callers swallow `ActivityCancelledError` now that every activity returns a Result, turning `Cancelled` into `Completed`                              | Existing warning promoted and applied to all activities in docs; covered by an effect-based test asserting the workflow's terminal status                      |
| Migration ceremony on activities that never fail meaningfully                                                                                        | Accepted. The uniform convention is the point; the named propagation helper keeps the one-line case one line                                                   |
| ~107 doc files to update, with drift risk                                                                                                            | Docs are part of the deliverable, not a follow-up. Examples must typecheck, which the repo already enforces via `turbo run typecheck`                          |

## Success criteria

1. `WorkflowInferActivity` has no conditional; every activity call returns
   `AsyncResult`.
2. `makeThrowingActivity` no longer exists.
3. An activity **without** declared errors, whose failure is propagated via the
   library's helper, produces the **same workflow status and attempt count** as
   before this change — proven on the real time-skipping server.
4. An activity without declared errors whose failure is _handled_ narrows
   correctly to `ActivityError | ActivityCancelledError`.
5. Cancellation still yields a `Cancelled` workflow when re-raised, and the
   swallow-hazard is documented for all activities.
6. Examples and docs updated; `pnpm turbo run typecheck` green repo-wide.
7. A changeset records the breaking change and the migration.

## Out of scope

- Idempotency / dedup guidance (workstream 4, part 2).
- Safe-by-default option shapes (workstream 4, part 3).
- The client-side typed API.
