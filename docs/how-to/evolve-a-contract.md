# Evolve a contract

A contract is shared by processes you do not deploy at the same instant —
clients, workflow workers, activity workers — and by executions that started
under the previous version and are still running. This guide covers which
changes are safe, which order to deploy them in, and how to gate the ones that
are not.

## Know what is re-checked against the new schema

Every boundary [validates on send and parses on receive](/explanation/validation-boundaries).
The receiving side always runs the schema of the code that is deployed _now_,
not the one that was deployed when the payload was written. Three cases follow:

- **Payloads in flight.** An activity task, child-workflow start, signal, or
  update already queued was validated by the sender's old schema. The receiver
  parses it with its new one.
- **Payloads already in history.** On replay, the workflow function runs again
  from the top: `declareWorkflow` re-parses the workflow input recorded in
  history, every activity and child-workflow result is re-parsed as it is
  replayed, and signal handlers re-parse their recorded inputs. A replay after
  a worker restart or a cache eviction is enough to trigger this — it is not
  rare.
- **Declared error payloads.** A `ContractError`'s `data` is re-validated when
  it is rehydrated. A payload that no longer validates degrades to the generic
  failure instead of the typed error: `ActivityError` / `ChildWorkflowError`
  in the workflow (the worker logs the miss through `log.warn`),
  `WorkflowFailedError` on the client (reported to `TypedClient.create`'s
  `onRehydrationMiss`).

A schema that rejects something it used to accept therefore fails _old
executions_, not just new calls. On replay, a workflow input that no longer
parses throws `WorkflowInputValidationError` where the original run went on to
schedule activities, and a replayed activity result that no longer parses
turns an `Ok` into an `Err` — either way the code takes a different path than
history recorded, which Temporal reports as a non-determinism error.

## Classify the change

| Change                                                     | Safe for in-flight executions? |
| ---------------------------------------------------------- | ------------------------------ |
| Add an optional field to an input, output, or error `data` | Yes                            |
| Widen a type (`z.literal("a")` → `z.enum(["a", "b"])`)     | Yes, receivers first           |
| Add a workflow, activity, signal, query, update, or error  | Yes, consumers first           |
| Make an optional field required, or narrow a type          | **No**                         |
| Change what a transforming schema produces                 | **No**                         |
| Rename a workflow, activity, signal, query, update, error  | **No**                         |
| Rename a search attribute, or change its `kind`            | **No**                         |
| Change `taskQueue`                                         | **No**                         |
| Change `startPolicy`                                       | No replay impact; see below    |
| Change a `workflowId` derivation                           | **No** for deduplication       |

**Names are wire identifiers.** A workflow name is the Temporal workflow type,
an activity name the activity type, a signal / query / update name the handler
name, an error name the `ApplicationFailure.type`. History records them. A
renamed activity is a different activity to every execution that already
scheduled the old one, and a renamed error stops rehydrating failures raised
under the old name. Add the new name alongside the old one, migrate, and
remove the old one only once no execution can reach it.

**A transform is part of the wire contract.** The handler receives the
schema's _output_, so changing `.transform(...)` or a `z.coerce.*` changes
the value replayed code sees for the same recorded payload — a determinism
change even though every payload still validates.

**`startPolicy` applies at start time only.** It becomes the
`workflowIdReusePolicy` of each new start request (client and child workflows
alike), so in-flight executions are untouched. Loosening it is still a
behavior change: moving `"once-per-id"` to `"allow-duplicate"` lets a
completed ID run again. See
[Declare a start policy](/how-to/define-a-contract#declare-a-start-policy).

**A `workflowId` derivation is your deduplication key.** Change it and the same
payload maps to a new ID: a retried start of an order begun under the old
derivation is no longer rejected by `startPolicy`, and `workflowIdFor` no
longer finds the old execution. Keep the old derivation until every execution
under it has closed, or accept a window where duplicates are possible. A
parent workflow derives its child's ID the same way, so for a child workflow
this is also a workflow-code change — gate it as below.

## Deploy in the right order

Make the **receiver** accept the new shape before any **sender** produces it:

| What changed                  | Receiver — deploy first                          | Sender — deploy second    |
| ----------------------------- | ------------------------------------------------ | ------------------------- |
| Workflow input                | Workflow workers                                 | Clients, parent workflows |
| Workflow output               | Clients, parent workflows                        | Workflow workers          |
| Activity input                | Activity workers                                 | Workflow workers          |
| Activity output               | Workflow workers                                 | Activity workers          |
| Signal / update input         | Workflow workers                                 | Clients                   |
| A new or changed error `data` | Whoever consumes it (workflow workers / clients) | Whoever raises it         |

A new declared error follows the same rule: the raising side refuses an error
its own contract does not declare (`ContractMisuseError`), and the consuming
side cannot type one it does not know, so ship the contract to consumers
first. When the change is a narrowing, run the table the other way round —
stop every sender producing the old shape first — and still drain or patch the
executions that hold it in history.

Default-stripping object schemas (zod's `z.object`, for instance) make adding
a field to an output harmless for old receivers; a strict schema
(`z.strictObject`) rejects it. Know which your schemas are.

## Gate workflow-code changes with patching

When a contract change forces a change in what the workflow _does_ — calling a
new activity, deriving a child ID differently, branching on a new field — use
Temporal's versioning API from `@temporalio/workflow`. Executions that started
before the patch replay the old path:

```typescript
import { patched } from "@temporalio/workflow";
import { propagateFailure } from "@temporal-contract/worker/workflow";

implementation: async (context, args) => {
  if (patched("score-risk-before-charge")) {
    await propagateFailure(context.activities.scoreRisk({ orderId: args.orderId }));
  }
  // ...
};
```

Once no execution started before the patch remains, replace `patched(...)`
with `deprecatePatch("score-risk-before-charge")` and keep only the new path;
remove that call in a later deploy. Patching guards _code_, not payloads: it
cannot make a narrowed schema accept a value already in history. For that,
keep the schema permissive until those executions close.
[Workflow determinism](/explanation/workflow-determinism#deploying-changed-workflow-code)
explains why replay needs this.

## Removing things

Remove a workflow, activity, or handler from the contract only after the last
execution that can reach it has closed. A worker that no longer registers an
activity cannot run the tasks old executions already scheduled — they fail
and retry under the activity's retry policy until it gives up. For long-lived workflows, prefer
[continue-as-new](/how-to/continue-as-new) onto the new version to shorten
that wait.

## Next

- [Validation boundaries](/explanation/validation-boundaries) — where each
  schema runs
- [Workflow determinism](/explanation/workflow-determinism) — replay and
  versioning
- [Model domain errors](/how-to/model-domain-errors) — rehydration and the
  wire format
