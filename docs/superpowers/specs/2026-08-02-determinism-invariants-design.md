# Determinism and money-safety invariants

**Date:** 2026-08-02
**Status:** Approved
**Scope:** Workstream 2 of 4 in the production-hardening effort

## Context

`temporal-contract` is in production use where real money depends on it. The
hardening driver is preventive — no incident has occurred.

The four workstreams:

1. Mock-free test architecture — **shipped 2026-08-02 (PR #359)**
2. **Determinism & money-safety invariants** (this spec)
3. API/type strength — making misuse unrepresentable
4. Pattern enforcement — forcing correct usage on end users

Workstream 1 established that the suite asserts real effects against a real
time-skipping server, and produced a mutation baseline of 61.45%. This
workstream uses that foundation to prove the invariants the library could
silently break.

### What "money-safety" means here

The library does not move money — it is a contract layer. Its money-safety role
is therefore **defensive**: Temporal offers guarantees, and the library sits
between the user and those guarantees. If the library corrupts one, the user's
workflow misbehaves in a way their own tests would not catch.

Idempotency surface (contract-level reuse/conflict policy, safe defaults) was
considered and **deliberately excluded**: `workflowIdReusePolicy` and
`workflowIdConflictPolicy` already pass through untouched
(`TypedWorkflowStartOptions` omits only `taskQueue`, `args`, and the two
search-attribute fields), so this is API design rather than invariant proving,
and it belongs with workstream 4.

### Measured starting state

| Invariant                | State                                                                  |
| ------------------------ | ---------------------------------------------------------------------- |
| `nonRetryable` behavior  | Asserted **only as a field value** on the `ApplicationFailure`         |
| Timeout behavior         | `startToCloseTimeout` proven by effect; `heartbeatTimeout` **nowhere** |
| Replay determinism       | **2 paths** of ~8 sandboxed constructs                                 |
| Idempotency pass-through | Works; no guidance (out of scope, see above)                           |

The `nonRetryable` gap is the one to lead with. Every existing assertion reads
`raw.nonRetryable === true` off the wire failure. That is a call-shape
assertion in the precise sense workstream 1 set out to eliminate — it would
survive the flag being dropped between the wire and Temporal's retry decision.
It persisted because those assertions were _added_ during workstream 1, as
fixes restoring a dropped property, and restoring a property is not the same as
proving a behavior.

## Invariants to prove

### Retry semantics

- A contract error declared `nonRetryable: true` results in **exactly one**
  activity attempt.
- A contract error declared `nonRetryable: false` results in **more than one**
  attempt.
- Attempt counts are read from the activity itself (`Context.current().info.attempt`)
  or a counter the activity increments — not inferred from elapsed time.

### Timeout semantics

- `startToCloseTimeout`, `scheduleToCloseTimeout`, and `heartbeatTimeout` reach
  Temporal as declared through all three option-merge layers
  (`declareWorkflow`'s `activityOptions` → contract-level `activityOptions` →
  `activityOptionsByName`).
- Asserted by reading `Context.current().info` inside the activity, which
  exposes `startToCloseTimeoutMs`, `scheduleToCloseTimeoutMs`, and
  `heartbeatTimeoutMs` — the values Temporal actually materialized for the
  scheduled task.

This mechanism was identified in workstream 1's final review as a lever the
whole workstream missed: it is an effect, not a call shape, and it removes the
multi-second real sleeps currently used to prove timeouts by waiting for them.

### Replay determinism

Every construct that runs unthrown pipelines or async Standard Schema
validation inside Temporal's sandbox must replay without a
`DeterminismViolationError`: workflow entry/exit, activity calls, signals,
queries, updates, child workflows, continue-as-new, and cancellation.

## Architecture

### The replay harvest rig

The in-process tier already runs ~56 tests producing real histories across
every construct. Replaying a history needs no server — only the workflow
bundle. Harvesting those histories therefore buys near-total replay coverage,
and — the durable part — **every future test gets replay coverage
automatically**, so it cannot rot the way an enumerated list does.

The obstacle: an `afterEach` cannot know which bundle to replay against,
because tests hold the bundle locally. The fix moves the seam to where the
bundle already is.

```ts
// before — two lines already present in every test
const worker = await TypedWorker.create({ contract, connection, workflowBundle: bundle }).get();
const typedClient = await TypedClient.create({ client: testEnv.client }).get();

// after — one line, same information
const { worker, client } = await testRig(testEnv, { contract, bundle, activities });
```

`testRig` lives in `@temporal-contract/testing` and returns:

- a `TypedWorker` built exactly as before, and
- a `ContractClient` that **records every `workflowId` it starts**, paired with
  the bundle the worker was built from.

Two signature details, both load-bearing:

- **`activities` is optional.** Workflow-only workers exist and must keep
  working — `TypedWorker.create` treats an absent `activities` key differently
  from `activities: undefined` (exactOptionalPropertyTypes discipline), so the
  rig must spread it conditionally rather than pass it through unconditionally.
- **The rig takes the contract as given and does not scope the task queue.**
  Callers keep calling `withTaskQueue(contract, nextTaskQueueId(...))`
  themselves. This is not laziness: workstream 1 established that a
  same-workflow continue-as-new _must_ land on the contract's static queue,
  because the contract is closed over inside the bundled workflow module and a
  test-side copy can never reach it. Six tests deliberately share the static
  queue for that reason. A rig that scoped unconditionally would break them.

An `afterEach` registered by the fixture fetches each recorded execution's
history and replays it with `Worker.runReplayHistory`.

Client construction is already uniform — 48 of ~52 in-process tests use a
byte-identical `TypedClient.create({ client: testEnv.client }).get()` line — so
this is a mechanical rewrite, not a redesign.

**Recording at the client, not listing from the server.** The alternative —
enumerating executions per task queue via visibility — would avoid touching
tests, but depends on the time-skipping test server supporting workflow
listing, which is unverified. Recording is independent of that.

### Non-terminal executions

Several tests deliberately leave workflows running (`condition(() => false)` as
a probe that never completes). Replaying a partial history may error rather
than pass.

The rig skips executions that are not in a terminal state — **and every skip
must be explicitly opted out by workflow-ID prefix with a stated reason**, in a
shrink-only allowlist mirroring `no-sdk-mocks.spec.ts`. An unlisted skip fails
the test.

A silently-skipped execution is exactly the coverage rot this workstream exists
to prevent: it would report replay coverage it does not have. The allowlist
makes each exemption a decision someone made on purpose.

## Risks

| Risk                                              | Mitigation                                                                                                 |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Non-terminal executions silently skipped          | Shrink-only allowlist keyed by workflow-ID prefix; unlisted skips fail                                     |
| Wall-clock growth on the slowest tier             | Replay needs no server. Measure before/after; if material, the lever is `poolOptions.forks.isolate: false` |
| The rig rewrite silently drops a test's assertion | Rewrite is mechanical and reviewed per file; the existing suite must stay green throughout                 |
| A replay failure is a _real_ determinism bug      | Stop and report it. Do not adjust the test to pass — that is the bug this workstream exists to find        |

That last row is the one to take seriously. If harvesting surfaces a genuine
`DeterminismViolationError` in shipped code, that is a **finding, not an
obstacle**, and it outranks the rest of the workstream.

## Out of scope

- Idempotency surface (reuse/conflict policy, safe defaults) — belongs to
  workstream 4.
- Cancellation semantics — proven in workstream 1
  (`cancellation.inprocess.spec.ts`, including the swallowed-cancellation
  hazard and its `rethrowCancellation` fix).
- Raising the Stryker `break` threshold — the baseline is one nightly old.

## Success criteria

1. `nonRetryable: true` and `false` are each proven by **attempt count**, not
   by a field read.
2. `startToCloseTimeout`, `scheduleToCloseTimeout`, and `heartbeatTimeout` are
   each proven through the option-merge layers via `Context.current().info`.
3. Every in-process test's history is replayed, or its skip is explicitly
   allowlisted with a reason.
4. The rig makes replay coverage automatic for future tests — adding a test
   requires no replay-specific code.
5. The existing suite stays green, and in-process wall-clock growth is measured
   and reported.
