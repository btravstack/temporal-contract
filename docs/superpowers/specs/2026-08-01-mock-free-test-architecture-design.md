# Mock-free test architecture

**Date:** 2026-08-01
**Status:** Approved
**Scope:** Workstream 1 of 4 in the production-hardening effort

## Context

`temporal-contract` is in production use where real money depends on it. The
hardening driver is **preventive** — no incident has occurred.

"Most robust as possible" decomposes into four independent workstreams:

1. **Mock-free test architecture** (this spec)
2. Determinism & money-safety invariants
3. API/type strength — making misuse unrepresentable
4. Pattern enforcement — forcing correct usage on end users

Workstream 1 comes first because the other three are unverifiable without it:
you cannot trust a hardening change when the suite that validates it asserts
against a hand-written fake of the dependency being hardened.

### Measured starting state

| Signal                | Value                                       |
| --------------------- | ------------------------------------------- |
| Spec files            | 38                                          |
| Worker unit coverage  | 93.7% stmts, **85.9% branch**, 89.3% funcs  |
| Files mocking the SDK | **12** (33 `vi.mock` calls, 262 `vi.fn`)    |
| Tests in mocked files | 241                                         |
| Test tiers            | `unit`, `integration` (Docker), `inprocess` |
| Coverage thresholds   | Configured, **not enforced**                |
| Mutation testing      | None                                        |

The 93.7% statement coverage is largely achieved _against a fake Temporal_.
This is the failure mode the spec targets: the fake agrees with our
assumptions, so the test passes while real Temporal behaves differently.

**Precedent.** The `isThenable` bug fixed in PR #357 was exactly this shape.
Standard Schema _types_ the async branch as `Promise<Result>`, but an
implementation may return any `PromiseLike`. Such a value slipped past
`instanceof Promise`; the code then read `.issues` off it (`undefined` → "no
issues, valid") and handed the handler an **unvalidated `undefined`**. It
survived a 94%-covered suite because nothing exercised the real path.

## The rule

> **Assert effects, never call shapes.**
>
> A test MAY construct real SDK objects and fake pure transport.
> A test MAY NOT fake SDK _semantics_. If the assertion is "we called Temporal
> with X," it must be replaced by "the workflow behaved correctly."

Worked examples:

```ts
// ALLOWED — real SDK object, faked transport.
const failure = ApplicationFailure.create({ type: "CardDeclined" });
fakeHandle.result = () => Promise.reject(failure);
expect(classify(failure)).toBeErrWithTag(CONTRACT_ERROR_TAG);

// BANNED — call-shape assertion.
vi.mock("@temporalio/workflow", () => ({ proxyActivities: capture }));
expect(proxyCalls[0].startToCloseTimeout).toBe("30s");

// REPLACEMENT — effect assertion on a real server.
// An activity that sleeps past its declared timeout must actually time out.
await expect(run(wf)).resolves.toBeErrWithTag(TIMEOUT_TAG);
```

The distinction is not "mock vs no mock" — it is **whether the test would
catch a divergence from Temporal's real semantics.**

## Architecture

### Three tiers

| Tier          | Runs on                      | Contains                                                    |
| ------------- | ---------------------------- | ----------------------------------------------------------- |
| `unit`        | Nothing external             | Pure logic; classification over **real** SDK error objects  |
| `inprocess`   | Time-skipping test server    | Anything SDK-semantic. **Default for new behavioral tests** |
| `integration` | Docker (Temporal + Postgres) | Full-stack wiring, schedules, multi-worker                  |

`inprocess` becomes the default home for behavioral tests: it exercises real
Temporal semantics without Docker, so it is both honest and cheap enough to
run per-PR.

### Fixture architecture

The `testEnv` fixture in `packages/testing/src/time-skipping.ts` is already
`{ scope: "worker" }`, so the `TestWorkflowEnvironment` is amortized across
each Vitest worker. **The environment is not the problem.**

The unamortized cost is **workflow bundling**, currently paid inside every
`TypedWorker.create({ workflowsPath })` call — i.e. once per test.

Add a module-level bundle cache to `@temporal-contract/testing`, keyed by
`workflowsPath`:

```
bundleFor(path): Map<string, Promise<{ code: string }>>
  → bundleWorkflowCode() runs at most once per path per Vitest worker

per test:
  TypedWorker.create({ workflowBundle, taskQueue: `t-${uniqueId}` })
```

Per-test isolation comes from a unique **task queue** and **workflow ID**,
both nearly free. This preserves independence without re-bundling.

`TypedWorker.create` already forwards `workflowBundle` to Temporal's
`Worker.create`; **no API change is required.**

**Constraint:** prebuilt bundles deliberately skip
`verifyWorkflowRegistration` (see the option's JSDoc). The four
`registration-*.workflows.ts` specs therefore MUST keep using `workflowsPath`
— the registration check is their subject under test.

## Migration map

**77** tests across 6 worker files migrate, **18** split, **146** stay
(77 + 18 + 146 = 241, the full population of mocked-file tests).

### Migrate — highest value first

Ordered by what a fake-vs-real divergence actually costs:

| File                      | Tests | Why it matters                                                                                                                                                                                                        |
| ------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `handlers.spec.ts`        | 28    | The update **validator slot** rejects pre-admission, before a history event is written. A mocked `setHandler` cannot reproduce this — it is the difference between a cleanly rejected update and a corrupted history. |
| `cancellation.spec.ts`    | 13    | Real `CancellationScope` propagation, including the swallowed-cancellation hazard where a declared-`errors` activity absorbs the cancel.                                                                              |
| `continue-as-new.spec.ts` | 10    | Real state carry-over. Losing state here loses money.                                                                                                                                                                 |
| `workflow-proxy.spec.ts`  | 15    | Pure call-shape: asserts `proxyActivities` options rather than that an activity honors them.                                                                                                                          |
| `wire-format.spec.ts`     | 8     | Call-shape over `executeChild` / `startChild`.                                                                                                                                                                        |
| `workflow-errors.spec.ts` | 3     | Call-shape over `proxyActivities`.                                                                                                                                                                                    |

### Split

`worker.spec.ts` (18) — config validation and option merging are pure and stay
in `unit`; registration-verification behavior moves to `inprocess`.

### Keep as-is

- `client.spec.ts` (108) and `schedule.spec.ts` (25) — these already satisfy
  the rule. They import **real** `ApplicationFailure`, `CancelledFailure`,
  `TimeoutFailure`, `TerminatedFailure` and fake only transport, so the
  error-classification logic is genuinely exercised against true shapes.
- `packages/testing/*` (3 files, 13 tests) — mock `testcontainers` /
  `@temporalio/testing` to test this package's own wiring. Low money risk.

## Enforcement

### Mock guard

Fail on `vi.mock("@temporalio/*")` outside an explicit allowlist, where each
entry carries a comment justifying why the path is unreachable on a real
server. Without this the migration decays back within months.

**Mechanism:** the repo lints with **oxlint only** (`"lint": "oxlint ."`), and
oxlint cannot express a custom rule of this shape. Adding ESLint solely for one
rule is disproportionate. Instead this is a **meta-test** —
`packages/testing/src/no-sdk-mocks.spec.ts` — that walks every `*.spec.ts` in
the workspace, greps for `vi.mock("@temporalio/…")`, and fails with the
offending file and line unless the path appears in a documented allowlist
constant.

Rationale: dependency-free, runs per-PR inside the normal suite, and produces a
better diagnostic than a lint rule would (it can name the tier the test should
move to).

Allowlist seeded with the three `packages/testing/*` wiring specs, each with a
one-line justification.

### Mutation testing

Stryker over `packages/contract` and `packages/worker`, **nightly, not
per-PR**. Mutation score is the only mechanism that measures whether a test
would _catch_ a bug rather than merely execute the line.

Scoped to pure modules — `contract-errors`, `wire-format`, `builder`,
`error-tags`, option merging — and explicitly NOT sandboxed workflow paths,
where run cost is prohibitive.

Expect a poor initial score, particularly where coverage is
execution-without-assertion. **That is the finding, not a failure.**

### Explicitly out of scope

- Property-based testing (`fast-check`) — considered, deferred.
- Enforced coverage floor — deferred. A threshold applied before the mocks are
  gone would lock in false confidence; revisit after migration.

## Risks

| Risk                                 | Mitigation                                                                                  |
| ------------------------------------ | ------------------------------------------------------------------------------------------- |
| Migrated tests flake on timing       | Use time-skipping; no wall-clock waits. Any `sleep` in a test is a review failure.          |
| Suite wall-clock grows               | Bundle cache; per-test task queues rather than per-test environments.                       |
| Coverage drops during migration      | Migrate file-by-file; each file's replacement lands in the same commit as its deletion.     |
| Shared env state bleeds across tests | Unique task queue + workflow ID per test.                                                   |
| Stryker runtime unbounded            | Nightly only, scoped to pure modules.                                                       |
| Registration checks silently skipped | `registration-*` specs pinned to `workflowsPath`; asserted in the lint allowlist rationale. |

## Success criteria

1. Zero `vi.mock("@temporalio/*")` outside the justified allowlist.
2. The 77 identified tests assert effects on a real time-skipping server, and
   `worker.spec.ts`'s 18 are split between `unit` and `inprocess`.
3. The `no-sdk-mocks` meta-test blocks reintroduction.
4. Stryker runs nightly over the scoped modules and reports a baseline score.
5. Per-PR suite wall-clock does not regress materially versus today.
