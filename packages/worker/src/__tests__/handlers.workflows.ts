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
 * Binds a handler on every sync-only schema slot fed an async schema; each
 * must be rejected by the per-call guard on use. Runs forever (never
 * signaled to finish) — the spec only issues queries and updates against it.
 */
export const probeEdgeCases = declareWorkflow({
  workflowName: "probeEdgeCases",
  contract: handlersContract,
  implementation: async (context) => {
    context.handleQuery("probeDodging", (echoed) => ({ echoed }));
    context.handleQuery("thenableDodging", (echoed) => ({ echoed }));
    context.handleQuery("asyncCheckedQueryOutput", () => ({ ok: true }));
    context.handleUpdate("asyncCheckedUpdateInput", async () => ({ ok: true }));
    await condition(() => false);
    return {};
  },
});

export const rejecting = declareWorkflow({
  workflowName: "rejecting",
  contract: handlersContract,
  implementation: async (context) => {
    context.handleUpdate("rejectUpdate", async () => {
      throw context.errors.Rejected();
    });
    context.handleSignal("reject", () => {
      throw context.errors.Rejected();
    });
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
