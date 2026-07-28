# Architecture

Why the packages are split the way they are, and why your own code has to be
split the same way.

## Four packages

| Package                       | Runs where     | Depends on                           |
| ----------------------------- | -------------- | ------------------------------------ |
| `@temporal-contract/contract` | Everywhere     | Nothing Temporal-specific            |
| `@temporal-contract/worker`   | Worker process | Temporal worker + workflow SDKs      |
| `@temporal-contract/client`   | Client process | Temporal client SDK                  |
| `@temporal-contract/testing`  | Tests          | Temporal testing SDK, testcontainers |

The contract package is deliberately the lightest. It holds schemas and types
and knows nothing about connections, workers, or the Temporal SDK. That is what
makes it safe to publish a contract as a shared package that both sides — and
other teams — depend on without dragging in a runtime.

All four version together as a fixed group, so one version number describes a
compatible set.

## Three worker entry points

`@temporal-contract/worker` has no root export. You import from a subpath:

```typescript
import { declareActivitiesHandler } from "@temporal-contract/worker/activity";
import { declareWorkflow } from "@temporal-contract/worker/workflow";
import { createWorker } from "@temporal-contract/worker/worker";
```

This is not organizational tidiness. Workflow code is compiled into an isolated
V8 sandbox with a restricted module graph, and it must not transitively reach
activity or worker dependencies. A single root export would make that impossible
to guarantee — importing one symbol would pull in the whole module graph.

Separate entry points mean the workflow bundle contains only what workflow code
can legally use.

## Why workflows are referenced by path

Everywhere else you pass values. For workflows you pass a **path**:

```typescript
const worker = await createWorker({
  contract: orderContract,
  connection,
  workflowsPath: workflowsPathFromURL(import.meta.url, "./workflows.js"),
  activities, // ← a value
}).get();
```

Temporal bundles the file at that path into the deterministic sandbox. It needs
a path because it is performing a build step, not taking a reference to an
already-loaded module. A live module object would already have been evaluated in
the host runtime, with whatever side effects that entailed.

`workflowsPathFromURL` is the ESM-safe resolver — there is no `require.resolve`
in ESM. Always include the extension, and always write `.js`, so the path is
correct in both source and built layouts.

## The file layout that follows

```
src/
  contract.ts     ← schemas and types only
  activities.ts   ← I/O: HTTP clients, database, SDKs
  workflows.ts    ← orchestration only. Bundled and sandboxed.
  worker.ts       ← wires them together
  client.ts       ← separate process
```

The load-bearing rule: **`workflows.ts` may import `contract.ts`, and nothing
with side effects.**

```typescript
// ❌ workflows.ts — pulls a driver into the sandbox, bundling fails
import { db } from "./database.js";

// ✅ workflows.ts
import { declareWorkflow } from "@temporal-contract/worker/workflow";
import { orderContract } from "./contract.js";
```

This constraint is why the layout is not a matter of taste. Put a workflow and
an activity in the same file and the workflow bundle will try to include your
database driver.

## The contract as the shared boundary

```
                    ┌──────────────┐
                    │  contract.ts │
                    └──────┬───────┘
              ┌────────────┼────────────┐
              ▼            ▼            ▼
        activities.ts  workflows.ts  client.ts
              └────────────┘
                    ▼
                 worker.ts
```

Every arrow points away from the contract. Nothing points back. The contract is
the only thing both processes share, so a change to it surfaces as a type error
on both sides at once — which is the entire proposition.

For separate deployments, publish it:

```
@acme/order-contract       ← schemas only
  ├── @acme/order-worker   ← depends on it
  └── @acme/order-client   ← depends on it
```

Now a breaking schema change fails the consumer's build rather than a production
workflow. Cross-contract [child
workflows](/how-to/run-child-workflows) work the same way across team
boundaries.

## Task queue as the deployment unit

The contract owns the task queue. That single fact chains outward:

```
one contract → one task queue → one worker deployment
```

So contract boundaries are deployment boundaries. Splitting a contract splits
what scales, deploys, and fails independently. That is the question to ask when
deciding where to draw the line — not "are these workflows conceptually
related?" but "should these scale and deploy together?"

Individual activities can still be routed elsewhere without splitting the
contract:

```typescript
activityOptionsByName: {
  scoreRisk: { taskQueue: "ml-inference" },
}
```

See [Tune activity options](/how-to/tune-activity-options).

## Where each concern lives

| Concern                                       | Belongs in      |
| --------------------------------------------- | --------------- |
| Schemas, types, error declarations            | `contract.ts`   |
| HTTP calls, database access, SDK clients      | `activities.ts` |
| Step ordering, retries-as-logic, compensation | `workflows.ts`  |
| Connection, concurrency, shutdown             | `worker.ts`     |
| Starting workflows, signals, queries          | `client.ts`     |

When something feels awkward to place, it is usually a workflow reaching for a
side effect. Push it into an activity.

## ESM only

All packages are `"type": "module"`. There is no CommonJS build of the source,
and relative imports need explicit `.js` extensions even for TypeScript files.

Temporal's workflow bundler and the sandbox's module resolution both assume
ESM semantics. A dual build would mean two module graphs, and the sandbox would
have to pick one.

## Next

- [Workflow determinism](/explanation/workflow-determinism)
- [Configure a worker](/how-to/configure-a-worker)
- [Define a contract](/how-to/define-a-contract)
