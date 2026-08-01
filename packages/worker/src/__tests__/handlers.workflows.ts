import { condition } from "@temporalio/workflow";

import { declareWorkflow } from "../workflow.js";
import { handlersContract } from "./handlers.contract.js";

export const counter = declareWorkflow({
  workflowName: "counter",
  contract: handlersContract,
  implementation: async (context) => {
    let total = 0;
    let finished = false;

    context.handleSignal("bump", ({ by }) => {
      total += by;
    });

    // `finish` is the workflow's only terminal signal — reaching it always
    // ends the workflow, regardless of `bump`'s accumulated total. A
    // zero-arg Temporal dispatch of a payload-less signal must extract to
    // `undefined`, not `[]`; if it didn't, `arg` would be truthy here and
    // this sabotages `total` to a value no passing test expects, instead of
    // silently passing.
    context.handleSignal("finish", (arg) => {
      if (arg !== undefined) total = -999;
      finished = true;
    });

    context.handleQuery("peek", () => ({ total }));
    context.handleQuery("describe", (label) => ({ label, total }));
    // Deliberately violates the declared output schema (`{ total: number }`)
    // — proves `bindQueryHandler` validates the handler's return value.
    context.handleQuery("brokenOutput", () => ({ total: "not-a-number" }) as never);

    context.handleUpdate("applyDelta", async ({ delta }) => {
      total += delta;
      return { total };
    });
    // Deliberately violates the declared output schema — the update-side
    // counterpart of `brokenOutput`.
    context.handleUpdate("brokenOutputUpdate", async () => ({ total: "not-a-number" }) as never);
    // The output schema is async-validating (`alwaysAsyncSchema`); allowed
    // for an update (unlike a query) because output validation runs inside
    // this async handler body, never admission-gated.
    context.handleUpdate("asyncOutputUpdate", async ({ text }) => ({ text }) as never);

    await condition(() => finished);

    return { total };
  },
});

/**
 * Exists solely to prove behavior 7: an async-validating query INPUT schema
 * trips `ContractMisuseError` at bind time (`context.handleQuery`, called
 * synchronously on the workflow's first Workflow Task), not on the first
 * live query. The `await condition(() => false)` below is never reached —
 * the bind throws first — but keeps the function's return type honest.
 */
export const bindsAsyncQuerySchema = declareWorkflow({
  workflowName: "bindsAsyncQuerySchema",
  contract: handlersContract,
  implementation: async (context) => {
    context.handleQuery("asyncCheckedQuery", () => ({ ok: true }));
    await condition(() => false);
    return {};
  },
});

/**
 * The OUTPUT-schema counterpart of `bindsAsyncQuerySchema` — proves
 * `bindQueryHandler`'s bind-time probe checks the output schema slot too,
 * independently of the input slot.
 */
export const bindsAsyncQueryOutputSchema = declareWorkflow({
  workflowName: "bindsAsyncQueryOutputSchema",
  contract: handlersContract,
  implementation: async (context) => {
    context.handleQuery("asyncCheckedQueryOutput", () => ({ ok: true }));
    await condition(() => false);
    return {};
  },
});

/**
 * Async-validating update INPUT schema — the update-side counterpart of
 * `bindsAsyncQuerySchema`. `bindUpdateHandler` runs its own
 * `assertSyncSchema(updateDef.input, ...)` call, separate from
 * `bindQueryHandler`'s; this proves that specific call site independently.
 */
export const bindsAsyncUpdateSchema = declareWorkflow({
  workflowName: "bindsAsyncUpdateSchema",
  contract: handlersContract,
  implementation: async (context) => {
    context.handleUpdate("asyncCheckedUpdateInput", async () => ({ ok: true }));
    await condition(() => false);
    return {};
  },
});

/**
 * The three schema-probe edge cases: a synchronously-throwing schema must
 * pass the bind-time probe (not a false positive); a schema that answers
 * the probe synchronously but validates real payloads asynchronously must
 * still be caught by the PER-CALL guard; same for a schema whose async
 * result is a bare thenable rather than a native `Promise`. Isolated from
 * `counter` so each stays easy to reason about independently. Runs forever
 * (never signaled to finish) — the spec only issues queries against it.
 */
export const probeEdgeCases = declareWorkflow({
  workflowName: "probeEdgeCases",
  contract: handlersContract,
  implementation: async (context) => {
    context.handleQuery("syncThrowProbe", (echoed) => ({ echoed }));
    context.handleQuery("probeDodging", (echoed) => ({ echoed }));
    context.handleQuery("thenableDodging", (echoed) => ({ echoed }));
    await condition(() => false);
    return {};
  },
});

/**
 * D1 wire format: proves the handler receives the PARSED (transformed)
 * input exactly once, while its ORIGINAL return value crosses the wire
 * untransformed (the client — or here `handle.raw`, which deliberately
 * skips re-parsing — applies the output transform on receive). Runs forever
 * — the spec only signals/queries/updates against it directly.
 */
export const transformWorkflow = declareWorkflow({
  workflowName: "transformWorkflow",
  contract: handlersContract,
  implementation: async (context) => {
    let receivedNoteText = "";

    context.handleSignal("note", ({ text }) => {
      receivedNoteText = text;
    });
    context.handleQuery("peekNote", () => ({ text: receivedNoteText }));
    context.handleQuery("peekText", ({ text }) => ({ receivedText: text, n: 21 }));
    context.handleUpdate("poke", async ({ text }) => ({ receivedText: text, n: 21 }));

    await condition(() => false);
    return {};
  },
});
