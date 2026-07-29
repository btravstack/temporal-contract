# Design: bind a second contract to an existing `TypedClient`

- **Date:** 2026-07-29
- **Status:** approved, not yet implemented
- **Target:** `@temporal-contract/client`, 8.0 beta line
- **Origin:** [millenium!56319 note 2210871](https://gitlab.factory.fonciamillenium.net/FonciaStark/millenium/-/merge_requests/56319#note_2210871)

> Design docs live in `.agents/specs/`, not `docs/`. The VitePress config sets no
> `srcExclude`, so every `.md` under `docs/` becomes a published page.

## Context

The originating comment asks two things:

> maybe we could create a nestjs provider for the TypedClient
>
> does it make sense to give the contract when calling `TypedClient.create`? It
> means we must have one TypedClient per contract. Instead we could have only one
> TypedClient and give the contract when calling `startWorkflow` or
> `executeWorkflow`? Or maybe we could find an other better DX

It sits on `lessor-tax-declaration.service.ts` in a draft MR titled _"POC: evaluate
replacing the in-house Temporal integration with temporal-contract (compute
slice)"_, where a `TypedClient` is constructed **inside a request-scoped method**:

```ts
async refreshDeclaration(declarationId: string): Promise<void> {
  // ...
  const typedClient = await TypedClient.create({
    contract: leaseAccountingComputeContract,
    client: this.client,
  })
    .mapErr((error) => match(error).with(tag("@temporal-contract/TechnicalError"), /* ... */).exhaustive())
    .getOrThrow();

  await typedClient.startWorkflow("computeOneLessorTaxDeclarationWorkflow", { /* ... */ });
}
```

### What the investigation found

1. **Construction is fallible and async only because of the connection.** `create`
   awaits `ensureConnected()` and routes setup faults to the defect channel.
   Contract binding itself is synchronous and free — `contract` feeds only
   `taskQueue`, workflow lookup, schema validation, and `TypedScheduleClient`.
   The two concerns are fused, which is what pushes construction into a request
   handler.
2. **Part of the pain is a version artifact.** The consumer pins
   `catalog:temporalContract7`. On 8.0 `create` returns
   `AsyncResult<TypedClient<TContract>, never>`, so the `mapErr` /
   `tag("@temporal-contract/TechnicalError")` ceremony above does not compile and
   collapses to `.get()`.
3. **The multi-contract burden is currently theoretical.** Across the millenium
   monorepo, temporal-contract is consumed by `applications/plato` (one contract)
   and, in this POC, `service-lease-accounting` (`leaseAccountingComputeContract`).
   One contract per application; no process binds two today.
4. **Precedent exists for contract-per-call.** The worker's
   `context.startChildWorkflow(contract, name, options)` takes the contract as a
   required first parameter.

## Non-goals

- **A NestJS integration package.** `@temporal-contract/client-nestjs` and
  `@temporal-contract/worker-nestjs` were deliberately removed in PR #116
  (`53dfb80`, 2026-03-01) to "simplify the project scope and reduce maintenance
  burden". The consumer additionally has its own in-house `@emeria/nestjs-temporal`
  (`@ContractActivitiesHandler()`, activity explorer), so the need is already met
  outside this repo. Re-adding it would reverse a deliberate decision to solve a
  problem the consumer has already solved. The removed provider was also
  one-module-per-contract, so it would not have addressed this complaint anyway.
- **Moving the contract to the call site** (`client.startWorkflow(contract, name,
options)`). Rejected: it taxes every call site to serve a case that does not
  exist yet, and `client.schedule` would need the contract threaded through
  `TypedScheduleClient` as well.

## Decision

Add one synchronous instance method to `TypedClient`.

```ts
class TypedClient<TContract extends ContractDefinition> {
  /**
   * Bind another contract, reusing this client's connection and interceptors.
   * Synchronous, infallible, memoized per contract identity.
   */
  for<TOther extends ContractDefinition>(contract: TOther): TypedClient<TOther>;
}
```

```ts
const client = (await TypedClient.create({ contract: leaseContract, client: temporal })).get();

await client.startWorkflow("computeOneLessorTaxDeclarationWorkflow", { workflowId, args });
await client.for(platoContract).startWorkflow("someOtherWorkflow", { workflowId, args });
```

Existing call sites are untouched, nothing is renamed, and no new type is exported.

### Semantics

- **Infallible.** The private constructor's only `throw` is the missing
  `client.schedule` check (`@temporalio/client` < 1.16). `for()` reuses the same
  `Client` that already passed that check during `create()`, so it cannot fail. It
  returns `TypedClient<TOther>` directly — no `AsyncResult` wrapper. This is the
  ergonomic win: binding is a plain expression, valid in a field initializer.
- **Memoized and identity-stable.** A
  `WeakMap<ContractDefinition, TypedClient<ContractDefinition>>` seeded with
  `[this.contract, this]`, so `client.for(ownContract) === client` and repeated
  `for(c)` returns the same instance instead of rebuilding `TypedScheduleClient`.
  The map erases the type parameter, so storing and reading each cross a cast —
  contained to the two lines inside `for()`.
- **Inherits `client` and `interceptors`.** No per-call interceptor override —
  YAGNI, and addable later without a break.
- **Never reconnects.** `ensureConnected()` stays a `create()`-time concern.

### Known wart

The bootstrap contract is privileged: contract B is reached _through_ contract A's
client. Accepted for now — see Follow-up.

## Implementation

Single file: `packages/client/src/client.ts`.

1. Add a private `bound` field:
   `WeakMap<ContractDefinition, TypedClient<ContractDefinition>>`.
2. Seed it with `this.contract -> this` at the end of the private constructor.
3. Add the public `for<TOther>(contract: TOther): TypedClient<TOther>` method:
   look up the memo, otherwise construct via the private constructor with
   `(contract, this.client, this.interceptors)`, store, return.
4. Add a TSDoc `@example` including `import { P } from "unthrown";` where the
   example matches on errors — per the convention that every standalone example
   block shows where its symbols come from.

The private constructor is reachable from `for()` because both live on the same
class, so no visibility change is needed.

## Testing

| Level       | File                                          | Cases                                                                                                                                                                                                                                                                  |
| ----------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Type        | `packages/client/src/types-inference.spec.ts` | `for(other).startWorkflow("nameFromOther")` compiles; a workflow name from the bootstrap contract is rejected on the derived client. This is where the real risk lives.                                                                                                |
| Unit        | `packages/client/src/client.spec.ts`          | `for(own) === client`; `for(c)` twice returns the same instance; the derived client uses the derived contract's `taskQueue`; input/output validation runs against the derived contract's schemas; interceptors are inherited; `ensureConnected()` is not called again. |
| Integration | `packages/client/src/__tests__/`              | New `second.contract.ts` + `second.workflows.ts` fixtures and a second `Worker` on the second task queue; one case proving `client.for(secondContract).executeWorkflow(...)` is routed to that queue against a live server.                                            |

The integration fixture mirrors the existing `worker` vitest fixture in
`__tests__/client.spec.ts` (`Worker.create` with `taskQueue`, `workflowsPath`,
`{ auto: true }`, shutdown in teardown).

## Documentation

- `docs/reference/client-surface.md` — add the `for()` entry.
- TSDoc `@example` on the method, which renders into the generated API docs.
- No new how-to page: a page for a single method is thin, and the reference entry
  plus the example carries it.

## Release

A `minor` changeset on `@temporal-contract/client`. The repo is in changesets pre
mode on the `beta` tag, so it folds into the next `8.0.0-beta.N`; the fixed group
bumps all four packages together.

## Follow-up (not in scope)

If a process ever binds three or more contracts, or the privileged bootstrap
contract causes a real ordering problem, introduce an unbound connection-scoped
root that mints contract-bound clients (`root.for(contract)`), keeping
`TypedClient.create({ contract, client })` as sugar. `for()` semantics are
identical, so call sites do not change.

## Unrelated defect found while investigating

`packages/worker/src/workflow.ts` — the TSDoc for `startChildWorkflow` and
`executeChildWorkflow` claims:

> - Same contract: Pass workflowName from current contract
> - Cross-contract: Pass contract and workflowName to invoke workflows from other workers

Both signatures take `contract` as a **required** first parameter; there is no
same-contract overload. The documentation describes an API that does not exist.
Fix separately.
