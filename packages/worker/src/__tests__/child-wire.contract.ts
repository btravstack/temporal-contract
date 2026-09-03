import { defineContract, defineSignal, defineWorkflow } from "@temporal-contract/contract";
import { z } from "zod";

/**
 * Contract for `child-wire.inprocess.spec.ts` — real (time-skipping server)
 * coverage of the wire-format guarantee (D1: validate on send, parse on
 * receive) at the workflow entry point and the child-workflow boundary. The
 * mocked `wire-format.spec.ts` this replaces could only assert that
 * `executeChild`/`startChild` were CALLED with a particular args shape; it
 * could never prove a transforming schema (`z.string().transform(...)`)
 * actually applies exactly once end to end. Marker transforms below append
 * "!" once per parse — a double-parse regression is directly observable
 * ("x!!" instead of "x!").
 *
 * SHARED STATIC QUEUE CAVEAT (mirrors `continue-as-new.contract.ts`):
 * `context.startChildWorkflow`/`executeChildWorkflow` always route to the
 * CONTRACT OBJECT passed at the call site inside the workflow
 * implementation — here, `childWireContract` itself, statically imported by
 * the bundled workflow module (`child-wire.workflows.ts`), never whatever
 * per-test `withTaskQueue`-scoped contract the test's own worker/client
 * happen to use. Every test that starts a child (`parentChild`,
 * `parentSignal`) must therefore bind its worker/client to the plain,
 * unscoped `childWireContract` — see `child-workflow.ts`'s
 * `taskQueue: childContract.taskQueue`, always derived from the contract
 * argument, never inherited from the parent's own queue. Tests that don't
 * start a child (`entryTransform`, `entryInvalidOutput`) keep normal
 * `withTaskQueue` per-test isolation.
 */
export const childWireContract = defineContract({
  taskQueue: "child-wire-tests",
  workflows: {
    /**
     * Workflow ENTRY POINT wire format — no child involved. `text`'s input
     * schema transforms on parse; `n`'s output schema transforms on parse.
     * The implementation echoes back exactly what it received (`text`) and
     * a literal (`n: 21`), so:
     * - `handle.raw.result()` (unparsed wire value) proves the worker
     *   received the PARSED input ("hi!", not "hi" or "hi!!") and sent the
     *   implementation's ORIGINAL output (n: 21, not 42).
     * - `handle.result()` (typed client, parses on receive) proves the
     *   client applies the output transform exactly once (n: 42, not 84).
     */
    entryTransform: defineWorkflow({
      input: z.object({ text: z.string().transform((s) => `${s}!`) }),
      output: z.object({ text: z.string(), n: z.number().transform((n) => n * 2) }),
      startPolicy: "allow-duplicate",
    }),

    /** Deliberately returns a value the output schema rejects. */
    entryInvalidOutput: defineWorkflow({
      input: z.object({}),
      output: z.object({ n: z.number() }),
      startPolicy: "allow-duplicate",
    }),

    /**
     * Child target for `parentChild`. `label`'s input schema transforms on
     * parse; `n`'s output schema transforms on parse — same dual-boundary
     * shape as `entryTransform`, but reached via the child-workflow helpers
     * instead of a direct client start.
     */
    child: defineWorkflow({
      input: z.object({ label: z.string().transform((s) => `${s}!`) }),
      output: z.object({ label: z.string(), n: z.number().transform((n) => n * 2) }),
      startPolicy: "allow-duplicate",
    }),

    /**
     * Drives both `executeChildWorkflow` and `startChildWorkflow` against
     * `child`, keyed by `mode`. The `start` mode additionally returns the
     * child's real `firstExecutionRunId` and `childWorkflowId`, letting the
     * spec independently verify them against Temporal's own record of the
     * child execution (not a stubbed handle).
     */
    parentChild: defineWorkflow({
      input: z.object({ mode: z.enum(["execute", "start"]), label: z.string() }),
      output: z.object({
        status: z.string(),
        label: z.string().optional(),
        n: z.number().optional(),
        firstExecutionRunId: z.string().optional(),
        childWorkflowId: z.string().optional(),
      }),
      startPolicy: "allow-duplicate",
    }),

    /**
     * Child target for `parentSignal`. `note`'s input schema transforms on
     * parse. Returns whatever it actually received (`null` if `note` never
     * arrived), so the spec can observe — via the child's own real output —
     * whether a signal genuinely reached the handler.
     */
    signalful: defineWorkflow({
      input: z.object({}),
      output: z.object({ noteText: z.string().nullable() }),
      startPolicy: "allow-duplicate",
      signals: {
        note: defineSignal({ input: z.object({ text: z.string().transform((s) => `${s}!`) }) }),
        finish: defineSignal(),
      },
    }),

    /**
     * Drives both the valid- and invalid-`note` scenarios against
     * `signalful`, keyed by `mode`. `sendError` surfaces the typed
     * `ChildWorkflowError` message when the invalid mode's send is rejected
     * client-side; `noteText` (echoed back from the child's own completed
     * result) proves whether the signal actually reached the handler.
     * `childWorkflowId` (the typed handle's own `workflowId`, not a locally
     * computed value) lets the spec independently look up the SAME child
     * execution the parent signaled.
     */
    parentSignal: defineWorkflow({
      input: z.object({ mode: z.enum(["valid", "invalid"]) }),
      output: z.object({
        status: z.string(),
        sendError: z.string().nullable(),
        noteText: z.string().nullable(),
        childWorkflowId: z.string().optional(),
      }),
      startPolicy: "allow-duplicate",
    }),
  },
});
