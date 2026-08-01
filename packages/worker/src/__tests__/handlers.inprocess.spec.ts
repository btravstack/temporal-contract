import { extname } from "node:path";
import { fileURLToPath } from "node:url";

import { TypedClient, WorkflowFailedError } from "@temporal-contract/client";
import { it } from "@temporal-contract/testing/time-skipping";
import {
  bundleFor,
  nextTaskQueueId,
  withTaskQueue,
} from "@temporal-contract/testing/workflow-bundle";
import { ApplicationFailure, ServiceError, WorkflowUpdateFailedError } from "@temporalio/client";
import { describe, expect } from "vitest";

import { TypedWorker } from "../worker.js";
import { handlersContract } from "./handlers.contract.js";

/**
 * Signal/query/update binding against a REAL time-skipping server — this is
 * the migration the mocked `setHandler` could never cover, because it can't
 * reproduce Temporal's update validator slot (pre-admission rejection, no
 * history event written) or the real client-side/worker-side split between
 * "the client rejected this before it left the process" and "the worker
 * rejected this after it arrived."
 *
 * `handle.raw` (the real `@temporalio/client` `WorkflowHandle`) is used in
 * three tests below to bypass our OWN typed client's client-side validation
 * — which uses the identical schema as the worker and would otherwise
 * reject bad input before it ever reached the server. That's not a mock:
 * it's the real SDK's real `signal`/`query`/`executeUpdate`, exercising the
 * real worker-side validation path.
 */
function workflowPath(filename: string): string {
  return fileURLToPath(new URL(`./${filename}${extname(import.meta.url)}`, import.meta.url));
}

describe("handler binding against a real server", () => {
  it("delivers a valid signal and drops an invalid one without failing the execution", async ({
    testEnv,
  }) => {
    const contract = withTaskQueue(handlersContract, nextTaskQueueId("handlers"));
    const bundle = await bundleFor(workflowPath("handlers.workflows"));

    const worker = await TypedWorker.create({
      contract,
      connection: testEnv.nativeConnection,
      workflowBundle: bundle,
    }).get();

    const typedClient = await TypedClient.create({ client: testEnv.client }).get();
    const client = typedClient.for(contract);

    const total = await worker.raw.runUntil(async () => {
      const handle = await client
        .startWorkflow("counter", { workflowId: "handlers-signal-drop", args: {} })
        .getOrThrow();

      // Invalid: `by` must be a positive integer. Sent through our own
      // typed client this would be rejected client-side (identical schema)
      // before ever reaching the server, proving nothing about the
      // worker's drop-and-log behavior. `handle.raw.signal` is the real
      // SDK's signal call, unmediated by our client, so the payload
      // genuinely reaches `bindSignalHandler` — which must DROP it, not
      // deliver it and not fail the execution.
      await handle.raw.signal("bump", { by: -1 });
      // Valid, and drives the workflow to its terminal value. If the
      // invalid signal above had reached the handler, `total` would land on
      // 9, not 10.
      await handle.signals.bump({ by: 10 });

      return handle.result().getOrThrow();
    });

    // EFFECT: the execution completed, and the bad signal contributed
    // nothing to the accumulated total.
    expect(total.total).toBe(10);
  });

  it("returns the query's validated output", async ({ testEnv }) => {
    const contract = withTaskQueue(handlersContract, nextTaskQueueId("handlers"));
    const bundle = await bundleFor(workflowPath("handlers.workflows"));

    const worker = await TypedWorker.create({
      contract,
      connection: testEnv.nativeConnection,
      workflowBundle: bundle,
    }).get();

    const typedClient = await TypedClient.create({ client: testEnv.client }).get();
    const client = typedClient.for(contract);

    await worker.raw.runUntil(async () => {
      const handle = await client
        .startWorkflow("counter", { workflowId: "handlers-query", args: {} })
        .getOrThrow();

      await handle.signals.bump({ by: 4 });

      // EFFECT: the query returns the handler's current (validated) state —
      // not a stale or default value.
      const peeked = await handle.queries.peek().getOrThrow();
      expect(peeked).toEqual({ total: 4 });

      await handle.signals.bump({ by: 6 });
      await handle.result().getOrThrow();
    });
  });

  it("rejects a query the worker's bind-time validation would fail, via the real QueryInputValidationError path", async ({
    testEnv,
  }) => {
    const contract = withTaskQueue(handlersContract, nextTaskQueueId("handlers"));
    const bundle = await bundleFor(workflowPath("handlers.workflows"));

    const worker = await TypedWorker.create({
      contract,
      connection: testEnv.nativeConnection,
      workflowBundle: bundle,
    }).get();

    const typedClient = await TypedClient.create({ client: testEnv.client }).get();
    const client = typedClient.for(contract);

    await worker.raw.runUntil(async () => {
      const handle = await client
        .startWorkflow("counter", { workflowId: "handlers-query-invalid", args: {} })
        .getOrThrow();

      // `describe`'s input schema is `z.string().min(1)`; our own typed
      // client would reject an empty string client-side (same schema),
      // never reaching the worker. `handle.raw.query` is the real SDK's
      // query call, unmediated by our client — it reaches the worker's
      // `bindQueryHandler`, which throws `QueryInputValidationError`
      // (a non-retryable `ApplicationFailure`), and the gRPC layer reports
      // it as a `ServiceError` whose `details` carry the failure message.
      let rejected: unknown;
      try {
        await handle.raw.query("describe", "");
      } catch (error) {
        rejected = error;
      }

      // EFFECT: the real SDK's query call failed, and specifically because
      // of the worker's `QueryInputValidationError` (its exact message,
      // naming the query) — not some other failure mode (e.g. an
      // unregistered handler, which would carry a different message).
      expect(rejected).toBeInstanceOf(ServiceError);
      expect((rejected as ServiceError).cause?.message).toContain(
        'Query "describe" input validation failed: Invalid input',
      );

      await handle.signals.bump({ by: 10 });
      await handle.result().getOrThrow();
    });
  });

  it("runs a valid update and returns its validated output", async ({ testEnv }) => {
    const contract = withTaskQueue(handlersContract, nextTaskQueueId("handlers"));
    const bundle = await bundleFor(workflowPath("handlers.workflows"));

    const worker = await TypedWorker.create({
      contract,
      connection: testEnv.nativeConnection,
      workflowBundle: bundle,
    }).get();

    const typedClient = await TypedClient.create({ client: testEnv.client }).get();
    const client = typedClient.for(contract);

    await worker.raw.runUntil(async () => {
      const handle = await client
        .startWorkflow("counter", { workflowId: "handlers-update-valid", args: {} })
        .getOrThrow();

      // EFFECT: the update ran the handler and returned its validated
      // output — the actual new total, not merely "no error".
      const updated = await handle.updates.applyDelta({ delta: 5 }).getOrThrow();
      expect(updated).toEqual({ total: 5 });

      await handle.signals.bump({ by: 10 });
      await handle.result().getOrThrow();
    });
  });

  it("rejects an invalid update pre-admission, leaving workflow history unaffected", async ({
    testEnv,
  }) => {
    const contract = withTaskQueue(handlersContract, nextTaskQueueId("handlers"));
    const bundle = await bundleFor(workflowPath("handlers.workflows"));

    const worker = await TypedWorker.create({
      contract,
      connection: testEnv.nativeConnection,
      workflowBundle: bundle,
    }).get();

    const typedClient = await TypedClient.create({ client: testEnv.client }).get();
    const client = typedClient.for(contract);

    await worker.raw.runUntil(async () => {
      const handle = await client
        .startWorkflow("counter", { workflowId: "handlers-update-invalid", args: {} })
        .getOrThrow();

      // `applyDelta`'s input schema requires a positive integer. Sent
      // through our own typed client, this would be rejected client-side
      // (identical schema) before ever reaching the server — which would
      // prove nothing about the worker's admission-time validator.
      // `handle.raw.executeUpdate` is the real SDK call, unmediated by our
      // client, so the payload genuinely reaches the worker's `validator`
      // slot.
      let rejected: unknown;
      try {
        await handle.raw.executeUpdate("applyDelta", { args: [{ delta: -5 }] });
      } catch (error) {
        rejected = error;
      }

      // EFFECT 1: the real SDK reports a validation-slot rejection, not a
      // handler failure — the two are the same wrapper class
      // (`WorkflowUpdateFailedError`) but distinguishable by `cause.type`,
      // exactly the way `@temporal-contract/client`'s own
      // `classifyUpdateError` tells "rejected at admission" apart from "the
      // admitted handler failed".
      expect(rejected).toBeInstanceOf(WorkflowUpdateFailedError);
      const cause = (rejected as WorkflowUpdateFailedError).cause;
      expect(cause).toBeInstanceOf(ApplicationFailure);
      expect((cause as ApplicationFailure).type).toBe("UpdateInputValidationError");

      // EFFECT 2 (the crux): no update-admission history event exists at
      // all — Temporal still schedules an ordinary Workflow Task to deliver
      // the update to the worker's validator (that ordinary
      // Scheduled/Started/Completed cycle is expected either way, admitted
      // or not), but a *rejected* update leaves none of the
      // update-specific event types Temporal would otherwise record:
      // Admitted, Accepted, Rejected, or Completed. This is the one
      // assertion the mocked `setHandler` could never make — it has no
      // concept of Temporal history at all.
      const UPDATE_EVENT_TYPES = new Set([41, 42, 43, 47]); // Accepted, Rejected, Completed, Admitted
      const history = await handle.raw.fetchHistory();
      const updateEvents = (history.events ?? []).filter((event) =>
        UPDATE_EVENT_TYPES.has(event.eventType ?? -1),
      );
      expect(updateEvents).toEqual([]);

      // Corroborating business-level check: state is untouched too.
      const peeked = await handle.queries.peek().getOrThrow();
      expect(peeked).toEqual({ total: 0 });

      await handle.signals.bump({ by: 10 });
      await handle.result().getOrThrow();
    });
  });

  it("trips ContractMisuseError at bind time for an async-validating query input schema", async ({
    testEnv,
  }) => {
    const contract = withTaskQueue(handlersContract, nextTaskQueueId("handlers"));
    const bundle = await bundleFor(workflowPath("handlers.workflows"));

    const worker = await TypedWorker.create({
      contract,
      connection: testEnv.nativeConnection,
      workflowBundle: bundle,
    }).get();

    const typedClient = await TypedClient.create({ client: testEnv.client }).get();
    const client = typedClient.for(contract);

    await worker.raw.runUntil(async () => {
      const handle = await client
        .startWorkflow("bindsAsyncQuerySchema", {
          workflowId: "handlers-async-schema-bind",
          args: {},
        })
        .getOrThrow();

      const result = await handle.result();

      // EFFECT: the workflow fails terminally, on its very first Workflow
      // Task, before ever serving a query — `context.handleQuery` throws
      // `ContractMisuseError` (a non-retryable `ApplicationFailure`) the
      // moment it probes the async-refining schema. If the bind-time probe
      // were missing, this workflow would instead hang `Running` forever
      // (the async validation would only be discovered — incorrectly — on
      // the first live query).
      expect(result.isErr()).toBe(true);
      if (!result.isErr()) return;
      expect(result.error).toBeInstanceOf(WorkflowFailedError);
      const cause = (result.error as WorkflowFailedError).cause;
      expect(cause).toBeInstanceOf(ApplicationFailure);
      expect((cause as ApplicationFailure).type).toBe("ContractMisuseError");
    });
  });
});
