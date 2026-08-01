import { extname } from "node:path";
import { fileURLToPath } from "node:url";

import { TypedClient, WorkflowFailedError } from "@temporal-contract/client";
import { it } from "@temporal-contract/testing/time-skipping";
import {
  bundleFor,
  nextTaskQueueId,
  withTaskQueue,
} from "@temporal-contract/testing/workflow-bundle";
import { ApplicationFailure } from "@temporalio/client";
import { describe, expect } from "vitest";

import { TypedWorker } from "../worker.js";
import { childWireContract } from "./child-wire.contract.js";

/**
 * Wire-format coverage (D1: validate on send, parse on receive) against a
 * REAL time-skipping server, for the workflow entry point and the
 * child-workflow helpers (`executeChildWorkflow` / `startChildWorkflow` /
 * child-signal send). The mocked `wire-format.spec.ts` this replaces faked
 * `executeChild`/`startChild` and asserted the ARGS SHAPE it was called
 * with — it could never prove a transforming schema actually applies
 * exactly once end to end, nor that `firstExecutionRunId` is a real
 * Temporal identifier rather than a stubbed one. Every test here instead
 * asserts an EFFECT: a value that only comes out right if the single-parse
 * guarantee holds.
 *
 * Receive-side signal/query/update wire coverage (a handler gets the parsed
 * value while its original return crosses the wire) already lives in
 * `handlers.inprocess.spec.ts` — not duplicated here. This file's scope is
 * the workflow entry point (`declareWorkflow` input/output) and the child
 * boundary (`executeChildWorkflow`/`startChildWorkflow`/child signals).
 */
function workflowPath(filename: string): string {
  return fileURLToPath(new URL(`./${filename}${extname(import.meta.url)}`, import.meta.url));
}

/**
 * Bounds every workflow started below — see `continue-as-new.inprocess.spec.ts`'s
 * identical constant for the measured real-time rationale. A regression that
 * mis-routes a child (wrong task queue) would otherwise hang the test to the
 * 120s `integration-inprocess` timeout instead of failing an assertion.
 */
const WORKFLOW_EXECUTION_TIMEOUT = "30 seconds";

/** `EVENT_TYPE_WORKFLOW_EXECUTION_SIGNALED` from `@temporalio/proto`'s `EventType` enum. */
const SIGNALED_EVENT_TYPE = 26;

describe("workflow entry point — wire format against a real server", () => {
  it("the implementation receives the PARSED input, and Temporal gets its ORIGINAL output (parsed once by the client)", async ({
    testEnv,
  }) => {
    const contract = withTaskQueue(childWireContract, nextTaskQueueId("child-wire"));
    const bundle = await bundleFor(workflowPath("child-wire.workflows"));

    const worker = await TypedWorker.create({
      contract,
      connection: testEnv.nativeConnection,
      workflowBundle: bundle,
    }).get();

    const typedClient = await TypedClient.create({ client: testEnv.client }).get();
    const client = typedClient.for(contract);

    const { raw, parsed } = await worker.raw.runUntil(async () => {
      const handle = await client
        .startWorkflow("entryTransform", {
          workflowId: "child-wire-entry-transform",
          args: { text: "hi" },
          workflowExecutionTimeout: WORKFLOW_EXECUTION_TIMEOUT,
        })
        .getOrThrow();

      // `entryTransform`'s implementation echoes back exactly what it
      // received (`text`) plus a literal (`n: 21`) — see the contract's doc
      // comment. Reading the SAME completed execution through both the raw
      // handle (unparsed wire value) and the typed handle (client-parsed
      // value) exposes both boundaries from one run.
      const raw = await handle.raw.result();
      const parsed = await handle.result().getOrThrow();
      return { raw, parsed };
    });

    // EFFECT (receive side of the INPUT boundary, and send side of the
    // OUTPUT boundary in one assertion): "hi!" proves the worker's
    // `declareWorkflow` parsed the client's original `{ text: "hi" }`
    // exactly once ("hi" would mean no parse; "hi!!" a double parse); `n:
    // 21` (not 42) proves the wire carries the implementation's ORIGINAL
    // output — the worker validates but does not transmit the parsed value.
    expect(raw).toEqual({ text: "hi!", n: 21 });
    // EFFECT (receive side of the OUTPUT boundary): the typed client parses
    // the wire's original n:21 exactly once, yielding 42 — not 84 (which a
    // double parse, e.g. the worker ALSO transforming before sending, would
    // produce).
    expect(parsed).toEqual({ text: "hi!", n: 42 });
  });

  it("fails the execution terminally when the implementation's return value fails output validation", async ({
    testEnv,
  }) => {
    const contract = withTaskQueue(childWireContract, nextTaskQueueId("child-wire"));
    const bundle = await bundleFor(workflowPath("child-wire.workflows"));

    const worker = await TypedWorker.create({
      contract,
      connection: testEnv.nativeConnection,
      workflowBundle: bundle,
    }).get();

    const typedClient = await TypedClient.create({ client: testEnv.client }).get();
    const client = typedClient.for(contract);

    const result = await worker.raw.runUntil(async () => {
      const handle = await client
        .startWorkflow("entryInvalidOutput", {
          workflowId: "child-wire-entry-invalid-output",
          args: {},
          workflowExecutionTimeout: WORKFLOW_EXECUTION_TIMEOUT,
        })
        .getOrThrow();

      return handle.result();
    });

    // EFFECT: the execution fails terminally with the SAME typed
    // WorkflowOutputValidationError `declareWorkflow`'s own output
    // validation raises — not a hang and not a generic failure.
    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error).toBeInstanceOf(WorkflowFailedError);
    const cause = (result.error as WorkflowFailedError).cause;
    expect(cause).toBeInstanceOf(ApplicationFailure);
    expect((cause as ApplicationFailure).type).toBe("WorkflowOutputValidationError");
    expect((cause as ApplicationFailure).message).toBe(
      'Workflow "entryInvalidOutput" output validation failed: at n: Invalid input',
    );
  });
});

/**
 * SHARED STATIC QUEUE CAVEAT (mirrors `continue-as-new.inprocess.spec.ts`):
 * `context.startChildWorkflow`/`executeChildWorkflow` always route to
 * whatever CONTRACT OBJECT the workflow implementation passes at the call
 * site — here, the plain `childWireContract` statically imported by
 * `child-wire.workflows.ts`, never a per-test `withTaskQueue`-scoped
 * contract the test's own worker/client happen to use (see
 * `child-workflow.ts`'s `taskQueue: childContract.taskQueue`, always
 * derived from the contract argument passed in, never inherited from the
 * parent's own queue). Every test below binds its worker/client to the
 * unscoped `childWireContract` instead, so the child always lands where
 * this worker is actually polling. Safe because Vitest runs this file's
 * tests sequentially and `worker.raw.runUntil` drains each worker before
 * its test returns — see the referenced file's longer note for the full
 * argument.
 */
describe("child-workflow boundary — wire format against a real server", () => {
  it("executeChildWorkflow: a transforming schema applies exactly once across each direction of the child boundary", async ({
    testEnv,
  }) => {
    const contract = childWireContract;
    const bundle = await bundleFor(workflowPath("child-wire.workflows"));

    const worker = await TypedWorker.create({
      contract,
      connection: testEnv.nativeConnection,
      workflowBundle: bundle,
    }).get();

    const typedClient = await TypedClient.create({ client: testEnv.client }).get();
    const client = typedClient.for(contract);

    const result = await worker.raw.runUntil(async () => {
      const handle = await client
        .startWorkflow("parentChild", {
          workflowId: "child-wire-execute-child",
          args: { mode: "execute", label: "x" },
          workflowExecutionTimeout: WORKFLOW_EXECUTION_TIMEOUT,
        })
        .getOrThrow();

      return handle.result().getOrThrow();
    });

    expect(result.status).toBe("ok");
    // EFFECT (input boundary): "x!" — the parent transmitted the ORIGINAL
    // `{ label: "x" }` (not the schema-parsed value) and the child parsed it
    // exactly once. "x" would mean no parse; "x!!" would mean a double parse
    // — the exact regression the v8 single-parse guarantee rules out.
    expect(result.label).toBe("x!");
    // EFFECT (result boundary): 42 — the child transmitted its ORIGINAL
    // `n: 21` and `executeChildWorkflow` parsed the result exactly once.
    expect(result.n).toBe(42);
  });

  it("startChildWorkflow: single-parse across the child boundary, and firstExecutionRunId is the child's REAL run id", async ({
    testEnv,
  }) => {
    const contract = childWireContract;
    const bundle = await bundleFor(workflowPath("child-wire.workflows"));

    const worker = await TypedWorker.create({
      contract,
      connection: testEnv.nativeConnection,
      workflowBundle: bundle,
    }).get();

    const typedClient = await TypedClient.create({ client: testEnv.client }).get();
    const client = typedClient.for(contract);

    const { parentResult, actualRunId } = await worker.raw.runUntil(async () => {
      const handle = await client
        .startWorkflow("parentChild", {
          workflowId: "child-wire-start-child",
          args: { mode: "start", label: "y" },
          workflowExecutionTimeout: WORKFLOW_EXECUTION_TIMEOUT,
        })
        .getOrThrow();

      const parentResult = await handle.result().getOrThrow();

      // Independent verification of `firstExecutionRunId` AND `workflowId`:
      // fetch the CHILD's own execution directly from Temporal (by the
      // `childWorkflowId` the parent's typed handle reported — see
      // `child-wire.workflows.ts`'s `handle.workflowId`, not a locally
      // computed value), bypassing whatever the parent captured entirely.
      // The mocked spec this replaces could only assert the handle carried
      // hardcoded stubs (`workflowId: "child-1"`, `firstExecutionRunId:
      // "run-1"`); this proves both are the child's ACTUAL identifiers.
      if (!parentResult.childWorkflowId) {
        throw new Error("expected parentChild to return a childWorkflowId");
      }
      const childHandle = client.getHandle("child", parentResult.childWorkflowId).getOrThrow();
      const description = await childHandle.raw.describe();
      return { parentResult, actualRunId: description.runId };
    });

    expect(parentResult.status).toBe("ok");
    // Same single-parse effect as the executeChildWorkflow test above, via
    // the startChildWorkflow + handle.result() path instead.
    expect(parentResult.label).toBe("y!");
    expect(parentResult.n).toBe(42);
    // EFFECT: the typed handle's `workflowId` is the id Temporal actually
    // started the child under — the SAME id fed back into `getHandle` above,
    // which would 404 (not merely mismatch) if `workflowId` were ever a
    // fabricated/unrelated value instead of a genuine passthrough.
    expect(parentResult.childWorkflowId).toBe("child-wire-start-child-child");
    // EFFECT: the handle's `firstExecutionRunId` matches Temporal's own
    // record of the child's run id — not a fabricated/stubbed value.
    expect(parentResult.firstExecutionRunId).toBe(actualRunId);
  });

  it("a valid child signal reaches the child's handler, with its transforming schema applied exactly once", async ({
    testEnv,
  }) => {
    const contract = childWireContract;
    const bundle = await bundleFor(workflowPath("child-wire.workflows"));

    const worker = await TypedWorker.create({
      contract,
      connection: testEnv.nativeConnection,
      workflowBundle: bundle,
    }).get();

    const typedClient = await TypedClient.create({ client: testEnv.client }).get();
    const client = typedClient.for(contract);

    const { result, signalNames } = await worker.raw.runUntil(async () => {
      const handle = await client
        .startWorkflow("parentSignal", {
          workflowId: "child-wire-signal-valid",
          args: { mode: "valid" },
          workflowExecutionTimeout: WORKFLOW_EXECUTION_TIMEOUT,
        })
        .getOrThrow();

      const result = await handle.result().getOrThrow();

      // Independent check, straight from the child's own Temporal history:
      // exactly which signals actually arrived, and in what order. Looked up
      // by the parent's own reported `childWorkflowId` (the typed handle's
      // real `workflowId`, not a hardcoded/duplicated derivation).
      if (!result.childWorkflowId) throw new Error("expected a childWorkflowId");
      const childHandle = client.getHandle("signalful", result.childWorkflowId).getOrThrow();
      const history = await childHandle.raw.fetchHistory();
      const events = history.events ?? [];
      const signalNames = events
        .filter((event) => event.eventType === SIGNALED_EVENT_TYPE)
        .map((event) => event.workflowExecutionSignaledEventAttributes?.signalName);
      return { result, signalNames };
    });

    expect(result.status).toBe("ok");
    expect(result.sendError).toBeNull();
    // EFFECT (the crux): "hi!" — read back from the CHILD's OWN completed
    // output, not the parent's echo of what it sent — proves the signal
    // genuinely reached the handler and its transforming schema applied
    // exactly once. "hi" would mean no parse; "hi!!" a double parse.
    expect(result.noteText).toBe("hi!");
    // EFFECT (corroborating, from real history): both signals were
    // delivered, in order — "finish" here doubles as the positive control
    // for the sibling "invalid" test's assert-empty below (proving this
    // detection mechanism actually observes a real signal when one is
    // sent).
    expect(signalNames).toEqual(["note", "finish"]);
  });

  it("an invalid child signal is rejected client-side (Err(ChildWorkflowError)) and never reaches the child", async ({
    testEnv,
  }) => {
    const contract = childWireContract;
    const bundle = await bundleFor(workflowPath("child-wire.workflows"));

    const worker = await TypedWorker.create({
      contract,
      connection: testEnv.nativeConnection,
      workflowBundle: bundle,
    }).get();

    const typedClient = await TypedClient.create({ client: testEnv.client }).get();
    const client = typedClient.for(contract);

    const { result, signalNames } = await worker.raw.runUntil(async () => {
      const handle = await client
        .startWorkflow("parentSignal", {
          workflowId: "child-wire-signal-invalid",
          args: { mode: "invalid" },
          workflowExecutionTimeout: WORKFLOW_EXECUTION_TIMEOUT,
        })
        .getOrThrow();

      const result = await handle.result().getOrThrow();

      if (!result.childWorkflowId) throw new Error("expected a childWorkflowId");
      const childHandle = client.getHandle("signalful", result.childWorkflowId).getOrThrow();
      const history = await childHandle.raw.fetchHistory();
      const events = history.events ?? [];
      const signalNames = events
        .filter((event) => event.eventType === SIGNALED_EVENT_TYPE)
        .map((event) => event.workflowExecutionSignaledEventAttributes?.signalName);
      return { result, signalNames };
    });

    expect(result.status).toBe("ok");
    // EFFECT 1: the send was rejected client-side with the SAME typed
    // classification and message `createTypedChildSignals` produces —
    // naming the child workflow, the signal, and the failing field.
    expect(result.sendError).toBe(
      'Child workflow "signalful" signal "note" input validation failed: at text: Invalid input',
    );
    // EFFECT 2 (corroborating): the child's OWN completed output shows it
    // never received a note.
    expect(result.noteText).toBeNull();
    // EFFECT 3 (the crux — a real "no send" proof, not just its receive-side
    // echo): the child's ACTUAL Temporal history contains no "note" signal
    // event at all — only "finish". Without this, deleting
    // `createTypedChildSignals`'s pre-send validation would go unnoticed:
    // the invalid `{ text: 42 }` would cross the wire, `signalful`'s own
    // `bindSignalHandler` would drop-and-log it (never calling the user
    // callback either), and `noteText` would stay `null` regardless —
    // satisfying EFFECT 2 above while a real (unwanted) signal delivery
    // happened underneath. The positive control is built in: "finish"
    // MUST still appear (proving the detection mechanism itself works),
    // exactly mirroring the sibling "valid" test's `["note", "finish"]`.
    expect(signalNames).toEqual(["finish"]);
  });
});
