# v8 review remediation — decisions and work breakdown

- **Date:** 2026-07-30
- **Status:** implemented on `feat/v8-full-review-fixes` (Waves 1-4 complete)
- **Origin:** full six-track review (client, worker, contract+testing, unthrown audit,
  amqp-contract consistency, DX/docs) performed 2026-07-29/30. This spec records the
  decisions and the fix plan. All breaking changes land inside the unshipped 8.0 beta.
- **Companion:** [2026-07-29-typed-client-contract-binding-design.md](2026-07-29-typed-client-contract-binding-design.md)
  (the `TypedClient`/`ContractClient` split), implemented as part of this work.

## Design decisions

### D1. Wire format: validate on send, parse on receive (fixes double-transform)

Today both sides of every boundary run the same Standard Schema and the sender
transmits the **parsed** value, so a transforming schema (`z.coerce.*`,
`.transform(...)`) is applied twice — silent data corruption.

Decision: **each boundary parses exactly once, on the receiving side.** The sender
still validates (to surface a typed `Err`/`ValidationError` early and to guarantee it
never emits garbage) but transmits the **original** value, discarding the parsed
result. Concretely:

- Client `startWorkflow`/`executeWorkflow`/`signalWithStart` args: validate, send the
  caller's original args. The worker parses and the handler receives the parsed value.
- Workflow/activity/query/update **results**: the producing side validates and returns
  the original value; the consuming side (client `result()`/`executeWorkflow`,
  workflow's activity proxy, update/query result paths) parses.
- Same rule for signals, updates, queries, child workflows, and both directions of
  activities.

Type surface is unchanged (`ClientInfer*`/`WorkerInfer*` duality already models
input-on-send / output-on-receive). Add tests with a transforming schema proving each
transform applies exactly once end-to-end. Update the worker's "double validation"
rationale comments to describe the new contract.

### D2. Signals: invalid payloads are dropped and logged, never thrown

Throwing `SignalInputValidationError` (non-retryable `ApplicationFailure`) from the
signal handler terminally kills the workflow execution — wrong for a fire-and-forget
message any stale client can send. Decision: on validation failure, **drop the signal
and `log.warn`** (via `@temporalio/workflow`'s `log`) with signal name + issues.
Delete `SignalInputValidationError`. Queries/updates keep their current (correct)
semantics. No configurable policy yet — YAGNI, addable without a break.

### D3. Contract-misuse errors in workflow code become non-retryable ApplicationFailures

`bindSignalHandler`/`bindQueryHandler`/`bindUpdateHandler` ("not found in contract",
"schema must be synchronous") and `buildRawActivitiesProxy` (activity-options coverage)
currently throw plain `Error` from inside the workflow sandbox, hanging executions in
infinite Workflow Task retries. Decision: introduce a `ContractMisuseError` extends
`ValidationError` (non-retryable `ApplicationFailure`) and use it at all such sites.

### D4. Scope cuts (deferred, not forgotten)

Checked = still deferred as of Wave 4 completion (nothing below landed in this work):

- [x] Typed **local activities** path — new feature, separate spec. _Still deferred._
- [x] Client `list`/`count` — covered by the new raw escape hatch for now. _Still deferred._
- [x] amqp-contract / async-contract convergence (`declare*` verbs, `for()` in amqp,
      `sideEffects`) — separate repos, separate track. _Still deferred._
- [x] Configurable invalid-signal policy (D2) and per-binding interceptor overrides.
      _Still deferred._

## Work breakdown

### Wave 1 — contract package + meta/docs (parallel)

Contract (`packages/contract`):

1. Activity-collision check: allow same-named activities across workflows when they are
   the **same object** (reference equality); error message for real collisions should
   recommend hoisting shared activities to the global `activities` block.
2. Reject workflow-name vs **global-activity-name** collisions in `defineContract`
   (they share the root of the implementations map).
3. Replace the zod meta-validation of contract shape with a hand-rolled structural
   validator (amqp-contract style); **drop the zod runtime dependency**. Root shape
   check becomes strict (unknown keys rejected), matching `defaultOptions`.
4. Make `input` optional on signal/query/update definitions (absent ⇒ handler input is
   `undefined`, no `z.void()` ceremony). Mirror in worker's `extractHandlerInput`
   (zero args ⇒ `undefined`) — worker side lands in Wave 3.
5. Delete `InferContractWorkflows` (trivial alias). Fix stale "unthrown 4" comment in
   `errors.ts`.
6. Drop the CJS build (ESM-only, rule 5): remove `main`/`module`/`require` conditions,
   align `types`.

Meta/docs (no package source):

7. `@beta` dist-tag warning + install commands on root README, `docs/how-to/install.md`,
   tutorial step 1 (npm `latest` is v7; docs teach v8).
8. CLAUDE.md rule 2 correction: unthrown 5 **does** export `OkAsync`/`ErrAsync`; the
   rule should say "no lowercase `okAsync`/`errAsync`; use `OkAsync`/`ErrAsync` or
   `.toAsync()`". Same fix in `.agents/rules/handlers.md` (also its free-function
   `isErr(result)` example → method style).
9. `dependencies.md`: add `@temporalio/testing ^1` to the testing row; align unthrown
   ranges.
10. `examples/README.md`: fix stale "Promise-based worker" / "Result/Future" wording,
    list all three example packages.

### Wave 2 — wire format (client + worker together)

Implement D1 across `packages/client` and `packages/worker` with transform-schema
tests (unit level in each package; one end-to-end case in the client integration
suite). No other refactors in this wave.

### Wave 3 — client and worker overhauls (parallel; contract package is frozen)

Client (`packages/client`):

11. Implement the `TypedClient`/`ContractClient` split per the companion spec
    (including its Testing/Documentation tables).
12. Fix `handle.result()` passing `workflowId` as `workflowName` to
    `WorkflowValidationError`; add a `workflowId` field to that error.
13. Schedule surface parity: typed `ScheduleAlreadyExistsError` /
    `ScheduleNotFoundError` (classified like workflow errors, replacing
    defect-channel-everything), add `update`, `backfill` on the handle and `list` on
    the schedule client; `TypedScheduleClient` constructor becomes non-public.
14. Escape hatch + identifiers: `readonly raw` (underlying `Client`) on the root;
    `firstExecutionRunId`/`runId` carried on typed handles; `getHandle` accepts
    `runId`/options and becomes **synchronous** returning
    `Result<TypedWorkflowHandle, WorkflowNotInContractError>`; add typed `startUpdate`
    alongside `executeUpdate`.
15. Rename `WorkflowNotFoundError` → `WorkflowNotInContractError` (SDK-name squat).
16. Delete the six unused `ClientInfer*` type exports; fix the inverted direction
    comment; `: {}` fallbacks → `Record<never, never>`.
17. Dedupe `executeWorkflow`'s inline copies of `classifyStartError`/
    `classifyResultError`; fold rehydrate-then-classify into one helper.
18. TSDoc/doc fixes: `createOrThrow` note (gone anyway with the split), orphaned
    `TypedSearchAttributeMap` doc block, "Thrown when…" → "Surfaced…", module docs
    above imports, `readonly` on handle fields and error arrays, search-attribute
    value `typeof`-per-kind check, `interceptors.ts` combinator names
    (`tapErrCases`/`recoverDefect`). Client README quick start `.getOrThrow()` →
    `.get()` and rewritten for the split. Type-level tests per the companion spec plus
    method-level inference pins.

Worker (`packages/worker`):

19. D2 (signal drop-and-log) and D3 (`ContractMisuseError`).
20. `declareActivitiesHandler`: error on workflow-name/global-activity collision
    (defense-in-depth with contract check); iterate **definitions** to fail fast on
    declared-but-missing implementations; consistent stray-key handling when
    `contract.activities` is undefined.
21. `TypedChildWorkflowHandle`: add typed `signals` map (validated per D1) and
    `firstExecutionRunId`.
22. `declareWorkflow`: runtime guard for unknown `workflowName` with available-names
    message.
23. Workflow-only workers: `activities` optional on `createWorker`; activity-less
    workflows no longer need `{}` entries (key remapping); `extractHandlerInput` zero
    args ⇒ `undefined` (pairs with contract change 4).
24. Rename exported `qualify` → `qualifyFailure` (no alias; beta window).
25. `ValidationError` `name` property `enumerable: false`; extract the repeated
    triple-nested conditional type helper; dedupe the duplicated sync-schema message.
26. Docs: fix the phantom same-contract child-workflow overload TSDoc; fix
    `declareWorkflow`'s `.getOrThrow()` example; rewrite worker README
    (`createWorker` + `workflowsPathFromURL`, `.js` imports, named contract export,
    correct `cause` idiom); `declareActivitiesHandler` TSDoc example uses
    `createWorker`.

### Wave 4 — testing package, examples, docs sweep, release (after Wave 3)

Testing (`packages/testing`) — needs the final client API:

27. Contract-aware fixtures: `createContractTest(contract, options)` yielding
    `{ client, worker, testEnv }`; `runActivity(definition, implementation, input)`
    over `MockActivityEnvironment`.
28. Forward `TimeSkippingTestWorkflowEnvironmentOptions` through
    `createTimeSkippingEnvironment(opts?)` and a fixture factory; descriptive error
    when `inject` values are missing (global-setup not registered); close
    `workerConnection` in try/catch; add `"./package.json"` export;
    `createGlobalSetup(options?)` factory (image tags, env, quiet).
29. Fix `time-skipping.ts` TSDoc `.getOrThrow()` examples.

Repo-wide:

30. Examples: extend order-processing with a signal + query + one typed contract
    error + a schedule, using the new client API.
31. Docs sweep: `upgrade-to-v8.md` migration sections for every breaking change here;
    `client-surface.md`; all construction snippets to
    `TypedClient.create({ client }).for(contract)`; regenerate API docs.
32. Adopt `publint --strict` + `attw --pack` (`check:package` script per package,
    catalog entries, CI wiring) — from amqp-contract.
33. Changesets: one `major` changeset per affected package (folds into next
    `8.0.0-beta.N`).
34. Full verification: build, typecheck, lint, unit tests everywhere; integration
    tests if Docker is available.
