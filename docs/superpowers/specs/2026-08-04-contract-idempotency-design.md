# Contract-declared idempotency

**Date:** 2026-08-04
**Status:** Approved
**Scope:** Workstream 4, part 2 of 3, of the production-hardening effort

## Context

`temporal-contract` is in production use where real money depends on it. The
hardening driver is preventive — no incident has occurred.

Shipped so far: mock-free test architecture (PR #359), determinism and
money-safety invariants (PR #360), compile-time contract validation (PR #369),
and uniform `AsyncResult` for activity calls (PR #370). Workstream 4's three
parts are the bimodal activity proxy (done), **idempotency and deduplication**
(this spec), and safe-by-default option shapes.

Workstream 2 considered this surface and **deliberately deferred it here**,
with a rationale worth preserving:

> Idempotency surface (contract-level reuse/conflict policy, safe defaults) was
> considered and **deliberately excluded**: `workflowIdReusePolicy` and
> `workflowIdConflictPolicy` already pass through untouched … so this is API
> design rather than invariant proving, and it belongs with workstream 4.

That framing still holds. **There is no bug here.** Pass-through works. The gap
is that the library offers no way to declare intent, so every start site
inherits a default that is wrong for the operations that matter most.

## The problem

`workflowIdReusePolicy` defaults to **`ALLOW_DUPLICATE`**
(`@temporalio/common/lib/workflow-options.d.ts:19-24`), which permits starting
a new run when the previous run with the same ID reached a **Closed** state —
**including `Completed`**.

So for a workflow keyed `charge-${orderId}`, a retried start call after a
successful charge starts a second charge. Temporal is behaving exactly as
documented; the default is simply the wrong one for an idempotent operation,
and nothing in the contract layer says so.

The two policies answer different questions, and conflating them is itself a
common source of error:

| Policy                     | Answers                                | Values                                                                            |
| -------------------------- | -------------------------------------- | --------------------------------------------------------------------------------- |
| `workflowIdReusePolicy`    | what happens against a **Closed** run  | `ALLOW_DUPLICATE` (default ⚠️), `ALLOW_DUPLICATE_FAILED_ONLY`, `REJECT_DUPLICATE` |
| `workflowIdConflictPolicy` | what happens against a **Running** run | `FAIL`, `USE_EXISTING`, `TERMINATE_EXISTING`                                      |

## The design

### The contract declares reuse; the caller keeps conflict

This split is the core idea, and it is not arbitrary:

- _"Is it safe to run this operation twice?"_ is a property of the
  **operation**. The contract author knows the answer and it does not vary by
  call site. → `workflowIdReusePolicy`, declared on the contract.
- _"What do I want if one is already running right now?"_ is a property of the
  **call** — attach to the in-flight run, fail, or replace it. Different
  callers legitimately want different answers. → `workflowIdConflictPolicy`,
  left where it is.

### A required field with named modes

`WorkflowDefinition` (`packages/contract/src/types.ts:217-235`) gains a
**required** `idempotency` field. Named modes rather than Temporal's enum,
because the enum names describe the mechanism while the modes describe the
intent:

| Contract declares   | Maps to                       | Means                                                    |
| ------------------- | ----------------------------- | -------------------------------------------------------- |
| `"once-per-id"`     | `REJECT_DUPLICATE`            | this workflow ID may run exactly once, ever              |
| `"retry-if-failed"` | `ALLOW_DUPLICATE_FAILED_ONLY` | re-runnable only if the previous attempt did not succeed |
| `"allow-duplicate"` | `ALLOW_DUPLICATE`             | Temporal's default, chosen deliberately                  |

**Required, not optional.** Optional would protect only the authors who already
knew to ask. The workflows most at risk are precisely those whose author never
considered re-runs, and those are the ones an optional field leaves on
`ALLOW_DUPLICATE`. Making it required forces the question to be asked once per
workflow, which is the entire value of the feature. A read-only workflow simply
writes `"allow-duplicate"`.

Defaulting to the _safe_ mode when omitted was considered and rejected: it
would silently change deduplication behavior for every existing contract on
upgrade, surfacing as a start that used to succeed and now fails — discovered
in production rather than at compile time.

### Application, with precedence that differs from `taskQueue`

The client applies the contract's mode as a **default** on `startWorkflow`,
`executeWorkflow`, and `signalWithStart`. An explicit per-call
`workflowIdReusePolicy` still wins.

This is a precision detail, not a formality. The contract's `taskQueue` is
applied **after** the caller's options spread — at `client.ts:858` for
`startWorkflow` and again at `client.ts:1005` for `signalWithStart` — so the
contract deliberately overrides the caller there. Idempotency needs the
**opposite** precedence, before the spread, so a deliberate per-call override
is honored. Getting this backwards would make the field impossible to override:
a different bug from failing to apply it, and one a test that only exercises
the default path would not catch.

Note there are **two** such sites, not one. Both must be changed, and
`executeWorkflow` must be checked as well — a fix applied to only the path the
tests happen to cover is exactly the shape of defect this project keeps
finding.

Worker-side child workflows (`TypedChildWorkflowOptions`,
`packages/worker/src/child-workflow.ts:40-43`) receive the same treatment, so a
workflow's declared intent holds however it is started.

## Testing

Per the workstream-1 rule — **assert effects, never call shapes**. A test that
checks the option was passed to Temporal proves nothing about deduplication.

The invariant is proven on the real time-skipping server:

- **`"once-per-id"`**: start a workflow, let it complete, start again with the
  same ID → the second start is **rejected**.
- **`"retry-if-failed"`**: start, let it **complete**, start again → rejected.
  Then start, let it **fail**, start again → **allowed**. Both directions are
  required; only the pair distinguishes this mode from the other two.
- **`"allow-duplicate"`**: start, complete, start again → allowed.
- **Override precedence**: a contract declaring `"once-per-id"` with an
  explicit per-call `ALLOW_DUPLICATE` → the second start succeeds. This is the
  test that catches the spread-order error described above.

## Migration surface

Measured on the current tree:

| Surface                                                     | Count |
| ----------------------------------------------------------- | ----- |
| `defineWorkflow(` call sites in `packages/` and `examples/` | 97    |
| Doc files containing `defineWorkflow(`                      | 19    |

Plus workflow definitions written inline inside `workflows: { … }` blocks,
mostly in test fixtures. Each needs one added line. The edit is mechanical, but
the diff is large and touches many fixtures — this is the dominant cost of the
change and should not be understated.

## What is NOT changing

- `workflowIdConflictPolicy` stays a per-call option, untouched.
- Pass-through behavior for callers who set policies explicitly.
- `workflowId` remains required, as inherited from Temporal.
- No change to how Temporal deduplicates. This spec changes which policy is
  _sent_, never what the server does with it.

## Risks

| Risk                                                                                       | Mitigation                                                                                                                                               |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Precedence implemented backwards, making the contract mode un-overridable                  | An explicit override test in the effect suite; the spread-order difference from `taskQueue` is called out in the plan                                    |
| The three modes do not cover a real need, forcing users out of the abstraction             | The escape hatch already exists — set `workflowIdReusePolicy` per call. The modes are a default, not a restriction                                       |
| Large mechanical migration introduces a wrong mode in a fixture                            | Fixtures whose tests assert deduplication behavior must keep asserting it; a fixture given the wrong mode should fail its own test, not merely typecheck |
| `signalWithStart` has different start semantics and may not honor reuse policy identically | Verify by effect rather than assuming; if it diverges, document the divergence rather than papering over it                                              |

## Success criteria

1. `idempotency` is required on every workflow definition; omitting it is a
   compile error.
2. Each of the three modes is proven by effect on the real server, including
   both directions of `"retry-if-failed"`.
3. An explicit per-call `workflowIdReusePolicy` overrides the contract's mode,
   proven by test.
4. Child workflows honor the declared mode.
5. Examples, docs, and fixtures migrated; `pnpm turbo run typecheck` green
   repo-wide.
6. A changeset records the breaking change and the migration.

## Out of scope

- Safe-by-default option shapes — workstream 4, part 3.
- `workflowIdConflictPolicy` as a contract-level declaration.
- Any change to Temporal's own deduplication semantics.
