# Design: decouple the client from the contract

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
   `AsyncResult<..., never>`, so the `mapErr` /
   `tag("@temporal-contract/TechnicalError")` ceremony above does not compile and
   collapses to `.get()`.
3. **The multi-contract case is not yet present.** Across the millenium monorepo,
   temporal-contract is consumed by `applications/plato` (one contract) and, in
   this POC, `service-lease-accounting` (`leaseAccountingComputeContract`). One
   contract per application; no process binds two today. The driver for this
   change is therefore separation of concerns, not contract count — see Rationale.
4. **Precedent exists for contract-per-call.** The worker's
   `context.startChildWorkflow(contract, name, options)` takes the contract as a
   required first parameter.

## Rationale

A client is a **connection**. A contract is a **schema**. Coupling them means a
connection cannot be established without first choosing a schema, which is
backwards: the connection is the scarce, fallible, process-lifetime resource, and
the schema is a free compile-time artifact.

The practical consequences of the current coupling:

- Establishing a connection requires naming a contract, so an application with
  two contracts opens two clients and runs `ensureConnected()` twice.
- The fallible, async step cannot be hoisted to process start without also fixing
  the contract there, which is what pushed construction into a request handler in
  the originating MR.

## Non-goals

- **A NestJS integration package.** `@temporal-contract/client-nestjs` and
  `@temporal-contract/worker-nestjs` were deliberately removed in PR #116
  (`53dfb80`, 2026-03-01) to "simplify the project scope and reduce maintenance
  burden". The consumer additionally has its own in-house `@emeria/nestjs-temporal`
  (`@ContractActivitiesHandler()`, activity explorer), so the need is already met
  outside this repo. The removed provider was also one-module-per-contract, so it
  would not have addressed this complaint anyway.
- **Moving the contract onto every call** (`client.startWorkflow(contract, name,
options)`). Rejected: it taxes every call site, and `client.schedule` would need
  the contract threaded through `TypedScheduleClient` as well. Binding once via
  `for()` gives the same decoupling without the per-call cost.

## Decision

Split the class in two.

```ts
/** Connection-scoped. No contract, no type parameter. */
export class TypedClient {
  static create(options: {
    client: Client;
    interceptors?: readonly ClientInterceptor[];
  }): AsyncResult<TypedClient, never>;

  /** Bind a contract. Synchronous, infallible, memoized per contract identity. */
  for<TContract extends ContractDefinition>(contract: TContract): ContractClient<TContract>;
}

/** Contract-scoped. Everything TypedClient<TContract> exposes today. */
export class ContractClient<TContract extends ContractDefinition> {
  startWorkflow(...): ...;
  executeWorkflow(...): ...;
  signalWithStart(...): ...;
  getHandle(...): ...;
  readonly schedule: TypedScheduleClient<TContract>;
}
```

```ts
const client = await TypedClient.create({ client: temporal }).get(); // once, at startup

await client.for(leaseContract).startWorkflow("computeOneLessorTaxDeclarationWorkflow", {
  workflowId,
  args,
});
await client.for(platoContract).startWorkflow("someOtherWorkflow", { workflowId, args });
```

No contract is privileged; every contract is reached the same way.

### Semantics

- **`for()` is infallible.** The `@temporalio/client >= 1.16` check (a missing
  `client.schedule`) moves to `TypedClient.create`, where it belongs — it is a
  property of the connection, not of any contract. `for()` therefore returns
  `ContractClient<TContract>` directly, with no `AsyncResult` wrapper. This is the
  ergonomic win: binding is a plain expression, valid in a field initializer.
- **Memoized and identity-stable.** A
  `WeakMap<ContractDefinition, ContractClient<ContractDefinition>>` on the root, so
  repeated `for(c)` returns the same instance rather than rebuilding
  `TypedScheduleClient`. The map erases the type parameter, so the store and the
  read each require a cast, contained to the two lines inside `for()`.
- **`ContractClient` inherits `client` and `interceptors` from the root.** No
  per-call interceptor override — YAGNI, and addable later without a break.
- **`create` still awaits `ensureConnected()`**, once per process rather than once
  per contract.

## Breaking changes

8.0 has not shipped, so these land inside the existing beta line rather than
forcing a new major.

| Before                                             | After                                          |
| -------------------------------------------------- | ---------------------------------------------- |
| `TypedClient.create({ contract, client })`         | `TypedClient.create({ client }).for(contract)` |
| `TypedClient<typeof contract>` (type annotation)   | `ContractClient<typeof contract>`              |
| `TypedClient.createOrThrow(contract, client, ...)` | removed                                        |

`create({ contract, client })` is **not** retained as a deprecated alias: keeping
it would preserve exactly the contract dependency this change removes.
`createOrThrow` is already `@deprecated` and takes a contract positionally, so it
goes at the same time.

Roughly 15 references to `TypedClient<...>` exist in-repo (tests, examples,
`docs/reference/client-surface.md`); about 6 are `TypedClient<typeof X>`
annotations that become `ContractClient<typeof X>`.

## Implementation

`packages/client/src/client.ts`.

1. Rename `class TypedClient<TContract>` to `ContractClient<TContract>`, keeping
   every member as-is. Its constructor stays private.
2. Move the `client.schedule` presence check out of that constructor into the new
   root's `create`.
3. Add `class TypedClient` holding `client`, `interceptors`, and the memo
   `WeakMap`; `static create({ client, interceptors })` performs the schedule check
   and `ensureConnected()`, returning `AsyncResult<TypedClient, never>`.
4. Add `TypedClient#for(contract)`: read the memo, otherwise construct a
   `ContractClient` with `(contract, this.client, this.interceptors)`, store,
   return.
5. Delete `createOrThrow` and `CreateTypedClientOptions`'s `contract` field.
6. Export `ContractClient` from the package entry point.
7. Add a TSDoc `@example` to both `create` and `for`, each showing its imports —
   per the convention that a standalone example block names where its symbols come
   from.

`ContractClient` must be constructible from `TypedClient#for`. Since they are
separate classes, the constructor cannot stay `private`; make it `internal` by
convention (a documented `@internal` TSDoc tag plus omission from the public
surface docs) rather than exporting a factory.

> `client.ts` is already ~1100 lines. Splitting `ContractClient` into its own
> module is tempting but would balloon the diff and obscure the rename in review.
> Keep both classes in `client.ts` for this change; split separately if it grows.

## Testing

| Level       | File                                          | Cases                                                                                                                                                                                                                                                                      |
| ----------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Type        | `packages/client/src/types-inference.spec.ts` | `for(c).startWorkflow(name)` accepts only `c`'s workflow names; two different contracts yield mutually incompatible `ContractClient` types. This is where the real risk lives.                                                                                             |
| Unit        | `packages/client/src/client.spec.ts`          | `for(c)` twice returns the same instance; two contracts yield distinct instances; each uses its own `taskQueue` and validates against its own schemas; interceptors are inherited; `ensureConnected()` runs once per root; `create` rejects a `Client` without `schedule`. |
| Integration | `packages/client/src/__tests__/`              | New `second.contract.ts` + `second.workflows.ts` fixtures and a second `Worker` on the second task queue; one case proving one root drives both contracts and that `for(secondContract).executeWorkflow(...)` is routed to the second queue against a live server.         |

Existing suites need their `TypedClient<typeof X>` fixtures retyped to
`ContractClient<typeof X>` and their construction updated to
`create({ client }).for(contract)`. The integration fixture mirrors the existing
`worker` vitest fixture in `__tests__/client.spec.ts` (`Worker.create` with
`taskQueue`, `workflowsPath`, `{ auto: true }`, shutdown in teardown).

## Documentation

- `docs/reference/client-surface.md` — document both classes and `for()`.
- `docs/how-to/upgrade-to-v8.md` — a migration section for the three breaking
  changes in the table above.
- Every `TypedClient.create({ contract, client })` occurrence across `docs/`,
  `README.md`, `packages/*/README.md` and `examples/` updated to the two-step
  form.
- TSDoc `@example` on `create` and `for`, which render into the generated API docs.

## Release

A `major` changeset on `@temporal-contract/client` — the change is breaking. The
repo is in changesets pre mode on the `beta` tag, so it folds into the next
`8.0.0-beta.N` rather than opening a 9.0 line; the fixed group bumps all four
packages together.

## Unrelated defect found while investigating

`packages/worker/src/workflow.ts` — the TSDoc for `startChildWorkflow` and
`executeChildWorkflow` claims:

> - Same contract: Pass workflowName from current contract
> - Cross-contract: Pass contract and workflowName to invoke workflows from other workers

Both signatures take `contract` as a **required** first parameter; there is no
same-contract overload. The documentation describes an API that does not exist.
Fix separately.
