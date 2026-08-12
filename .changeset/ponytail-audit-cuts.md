---
"@temporal-contract/client": major
"@temporal-contract/contract": major
"@temporal-contract/worker": major
"@temporal-contract/testing": major
---

Remove over-engineered surface found by a repo-wide complexity audit.

**Breaking — `@temporal-contract/client`**

- **Client interceptors are gone.** `CreateClientOptions.interceptors`,
  `ClientInterceptor`, `ClientInterceptorArgs`, `ClientInterceptorNext`, and
  `ClientCallError` are no longer exported, and `TypedClient.create` no longer
  accepts an `interceptors` array. Every client method already returns an
  `AsyncResult`, so wrap the call site with the combinators (`tapErrCases`,
  `recoverDefect`, `map`) or your own function instead.
- **Tag bundles are gone.** `WORKFLOW_START_ERROR_TAGS`,
  `WORKFLOW_OUTCOME_ERROR_TAGS`, `WORKFLOW_RESULT_ERROR_TAGS`, the
  `tagPatterns(tags)` helper, and the `TagPatterns` type are no longer
  exported. List the tags a handler covers directly in one `.with(...)` arm —
  the per-error `*_ERROR_TAG` constants are unchanged, and the matcher's
  exhaustiveness check still forces the arm to widen when a union grows.
- **Search-attribute values are no longer type-checked at runtime.** Passing a
  value whose JavaScript type disagrees with the declared `kind` is a
  compile-time error and is rejected server-side; the redundant runtime check
  (and its `RuntimeClientError`) has been removed. The check for an
  **undeclared** attribute name is unchanged — that one catches a silent
  failure to index.

**Internal — no public API change**

- `@temporal-contract/contract` drops `ValidateContract`, the compile-time
  mirror of `defineContract`'s runtime validation (a type-level `ms`-duration
  parser and name-collision detector). It was never exported; the runtime
  checks in `defineContract` were always authoritative and are unchanged, so
  every invalid contract is still rejected — at `defineContract` call time
  rather than at `tsc` time.
- `@temporal-contract/worker`'s eight payload-validation error classes now
  share one message formatter. Class names, failure `type` strings, `direction`
  literals, scope-named fields (`activityName` / `workflowName` / `queryName` /
  `updateName`), and message text are all unchanged.
- `@temporal-contract/testing` drops two lint-rules-as-vitest-specs that walked
  the source tree against hand-maintained allowlists.
