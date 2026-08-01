import { extname } from "node:path";
import { fileURLToPath } from "node:url";

import { TypedClient, WorkflowFailedError } from "@temporal-contract/client";
import { it } from "@temporal-contract/testing/time-skipping";
import {
  bundleFor,
  nextTaskQueueId,
  withTaskQueue,
} from "@temporal-contract/testing/workflow-bundle";
import {
  ApplicationFailure,
  QueryNotRegisteredError,
  ServiceError,
  WorkflowUpdateFailedError,
} from "@temporalio/client";
import { Runtime, type Logger } from "@temporalio/worker";
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
 * `handle.raw` (the real `@temporalio/client` `WorkflowHandle`) bypasses our
 * OWN typed client's client-side validation in two situations:
 *
 * - a "bad payload" test, where the typed client would use the identical
 *   schema and reject the payload before it ever reached the server; or
 * - a "wire format" test, where the typed client would re-parse the RECEIVED
 *   output on our behalf, hiding the raw (possibly still-transformed, if
 *   buggy) value the worker actually put on the wire.
 *
 * Neither is a mock: it's the real SDK's real `signal`/`query`/
 * `executeUpdate`/`fetchHistory`, exercising the real worker-side path.
 */
function workflowPath(filename: string): string {
  return fileURLToPath(new URL(`./${filename}${extname(import.meta.url)}`, import.meta.url));
}

type CapturedLog = { level: string; message: string };

/**
 * Captures workflow-emitted `log.*` calls by temporarily replacing
 * `Runtime.logger` — the SDK's own documented hook for this ("To capture
 * log messages emitted by Workflow code, set the `Runtime.logger`
 * property", per `@temporalio/worker`'s public types). The sink interface
 * name workflow logging is funneled through (`__temporal_logger`) is
 * reserved and cannot be registered directly via `WorkerOptions.sinks` —
 * `Worker.create` throws `Cannot use sink name: '__temporal_logger', with
 * reserved prefix` if you try.
 *
 * `Runtime` is a process-wide singleton, shared with every other test in
 * this file (and any other file sharing the same Vitest worker process).
 * `Runtime.install(...)` would throw `IllegalStateError` once any earlier
 * test has already instantiated it (which happens the moment any
 * `TypedWorker.create` call in this file runs). Swapping `logger` on the
 * ALREADY-instantiated singleton via `Runtime.instance()` avoids that, and
 * wrapping (not replacing) the original logger keeps normal log output
 * intact for every other test. The caller MUST restore the original logger
 * — via the returned `restore()` — in a `finally` block, so a failing
 * assertion can't leave the capture installed for subsequent tests.
 */
function captureWorkflowLogs(): { logs: CapturedLog[]; restore: () => void } {
  const logs: CapturedLog[] = [];
  const runtime = Runtime.instance();
  const original = runtime.logger;
  const capturing: Logger = {
    log: (level, message, meta) => {
      logs.push({ level, message });
      original.log(level, message, meta);
    },
    trace: (message, meta) => capturing.log("TRACE", message, meta),
    debug: (message, meta) => capturing.log("DEBUG", message, meta),
    info: (message, meta) => capturing.log("INFO", message, meta),
    warn: (message, meta) => capturing.log("WARN", message, meta),
    error: (message, meta) => capturing.log("ERROR", message, meta),
  };
  // `Runtime.logger` is `readonly` at the type level only — TypeScript
  // doesn't emit a runtime freeze, so a cast is the only way to swap it.
  (runtime as unknown as { logger: Logger }).logger = capturing;
  return {
    logs,
    restore: () => {
      (runtime as unknown as { logger: Logger }).logger = original;
    },
  };
}

describe("handler binding against a real server", () => {
  it("delivers a valid signal, drops and logs an invalid one, and ends via a payload-less finish signal", async ({
    testEnv,
  }) => {
    const contract = withTaskQueue(handlersContract, nextTaskQueueId("handlers"));
    const bundle = await bundleFor(workflowPath("handlers.workflows"));
    const { logs: capturedLogs, restore: restoreLogger } = captureWorkflowLogs();

    try {
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
        // typed client this would be rejected client-side (identical
        // schema) before ever reaching the server, proving nothing about
        // the worker's drop-and-log behavior. `handle.raw.signal` is the
        // real SDK's signal call, unmediated by our client, so the payload
        // genuinely reaches `bindSignalHandler` — which must DROP it, not
        // deliver it and not fail the execution.
        await handle.raw.signal("bump", { by: -1 });
        // Valid.
        await handle.signals.bump({ by: 10 });
        // `finish` is payload-less and always ends the workflow,
        // independent of `bump`'s accumulated total — a regression in the
        // drop behavior above now fails the `toBe(10)` assertion below
        // immediately instead of hanging the test until the workflow
        // execution timeout. The zero-arg dispatch here must extract to
        // `undefined`, not `[]`; if it didn't, `finish`'s handler
        // sabotages `total` to `-999` (see handlers.workflows.ts).
        await handle.signals.finish();

        return handle.result().getOrThrow();
      });

      // EFFECT 1: the execution completed with the bad signal contributing
      // nothing, AND the zero-arg `finish` dispatch was correctly
      // extracted (a wrong extraction would show up as -999, not 10).
      expect(total.total).toBe(10);

      // EFFECT 2: the drop was logged, not silent.
      const dropped = capturedLogs.find(
        (l) => l.level === "WARN" && l.message.includes('Dropped signal "bump"'),
      );
      expect(dropped?.message).toBe(
        'Dropped signal "bump": input validation failed: at by: Invalid input',
      );
    } finally {
      restoreLogger();
    }
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

      await handle.signals.finish();
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

      await handle.signals.finish();
      await handle.result().getOrThrow();
    });
  });

  it("surfaces QueryOutputValidationError when the handler returns a value the output schema rejects", async ({
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
        .startWorkflow("counter", { workflowId: "handlers-query-broken-output", args: {} })
        .getOrThrow();

      // `brokenOutput`'s handler always returns `{ total: "not-a-number" }`
      // — a value the `{ total: number }` output schema rejects. Proves
      // `bindQueryHandler` validates the handler's RETURN value, not just
      // its input; nothing about this call's input is invalid.
      let rejected: unknown;
      try {
        await handle.raw.query("brokenOutput");
      } catch (error) {
        rejected = error;
      }

      expect(rejected).toBeInstanceOf(ServiceError);
      expect((rejected as ServiceError).cause?.message).toContain(
        'Query "brokenOutput" output validation failed',
      );

      // EFFECT: a failed query doesn't corrupt the execution — it's still
      // alive and answers a subsequent, valid query.
      await handle.signals.finish();
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

      await handle.signals.finish();
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
      // Admitted, Accepted, Rejected, or Completed.
      //
      // A positive control (WorkflowExecutionStarted, type 1, MUST be
      // present) guards against this assertion passing vacuously — an
      // `eventType` decoding change (e.g. a future SDK returning it as a
      // string enum) or an empty/undefined `history.events` would otherwise
      // make the "no update events" filter trivially `[]` and this
      // assertion would pass while proving nothing.
      const WORKFLOW_STARTED_EVENT_TYPE = 1;
      const UPDATE_EVENT_TYPES = new Set([41, 42, 43, 47]); // Accepted, Rejected, Completed, Admitted
      const history = await handle.raw.fetchHistory();
      const events = history.events ?? [];
      const startedEvents = events.filter(
        (event) => event.eventType === WORKFLOW_STARTED_EVENT_TYPE,
      );
      const updateEvents = events.filter((event) => UPDATE_EVENT_TYPES.has(event.eventType ?? -1));
      expect(startedEvents.length).toBeGreaterThanOrEqual(1);
      expect(updateEvents).toEqual([]);

      // Corroborating business-level check: state is untouched too.
      const peeked = await handle.queries.peek().getOrThrow();
      expect(peeked).toEqual({ total: 0 });

      await handle.signals.finish();
      await handle.result().getOrThrow();
    });
  });

  it("surfaces UpdateOutputValidationError when the handler returns a value the output schema rejects", async ({
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
        .startWorkflow("counter", { workflowId: "handlers-update-broken-output", args: {} })
        .getOrThrow();

      // `brokenOutputUpdate`'s input (`{}`) is valid, so this update IS
      // ADMITTED — unlike the pre-admission rejection above, this fails
      // POST-admission because the handler's return value
      // (`{ total: "not-a-number" }`) rejects the `{ total: number }`
      // output schema. Output validation runs inside the async handler
      // body, never admission-gated, so `handle.raw.executeUpdate` isn't
      // strictly required for this one — used anyway for the same precise,
      // real-SDK-error assertion style as the rest of this file.
      let rejected: unknown;
      try {
        await handle.raw.executeUpdate("brokenOutputUpdate", { args: [{}] });
      } catch (error) {
        rejected = error;
      }

      expect(rejected).toBeInstanceOf(WorkflowUpdateFailedError);
      const cause = (rejected as WorkflowUpdateFailedError).cause;
      expect(cause).toBeInstanceOf(ApplicationFailure);
      expect((cause as ApplicationFailure).type).toBe("UpdateOutputValidationError");

      await handle.signals.finish();
      await handle.result().getOrThrow();
    });
  });

  it("allows an async-validating update OUTPUT schema — the deliberate query/update asymmetry", async ({
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
        .startWorkflow("counter", { workflowId: "handlers-async-output-update", args: {} })
        .getOrThrow();

      // `asyncOutputUpdate`'s OUTPUT schema validates asynchronously
      // (unconditionally). Unlike a query — where EITHER schema slot
      // validating asynchronously trips a bind-time `ContractMisuseError`
      // — an update's output validation runs inside the async handler
      // body, never admission-gated, so this is explicitly ALLOWED. EFFECT:
      // the update actually completes and returns the expected value,
      // proving the async output schema was awaited and applied, not just
      // "didn't crash".
      const updated = await handle.updates.asyncOutputUpdate({ text: "ok" }).getOrThrow();
      expect(updated).toEqual({ text: "ok" });

      await handle.signals.finish();
      await handle.result().getOrThrow();
    });
  });

  it("trips ContractMisuseError at bind time for an async-validating query INPUT schema", async ({
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
      expect((cause as ApplicationFailure).message).toContain(
        "the input schema validates asynchronously",
      );
    });
  });

  it("trips ContractMisuseError at bind time for an async-validating query OUTPUT schema", async ({
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
        .startWorkflow("bindsAsyncQueryOutputSchema", {
          workflowId: "handlers-async-output-schema-bind",
          args: {},
        })
        .getOrThrow();

      const result = await handle.result();

      // Same mechanism as the input-schema variant above, but proves the
      // OUTPUT schema slot's bind-time probe fires independently — i.e.
      // `bindQueryHandler` doesn't just probe input and skip output.
      expect(result.isErr()).toBe(true);
      if (!result.isErr()) return;
      expect(result.error).toBeInstanceOf(WorkflowFailedError);
      const cause = (result.error as WorkflowFailedError).cause;
      expect(cause).toBeInstanceOf(ApplicationFailure);
      expect((cause as ApplicationFailure).type).toBe("ContractMisuseError");
      expect((cause as ApplicationFailure).message).toContain(
        "the output schema validates asynchronously",
      );
    });
  });

  it("trips ContractMisuseError at bind time for an async-validating update INPUT schema", async ({
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
        .startWorkflow("bindsAsyncUpdateSchema", {
          workflowId: "handlers-async-update-schema-bind",
          args: {},
        })
        .getOrThrow();

      const result = await handle.result();

      // `bindUpdateHandler` runs its own, separate `assertSyncSchema` call
      // for the update's input schema — this is NOT the same code path as
      // the query-input variant above (different call site in
      // `handlers.ts`), so that test alone wouldn't catch a regression
      // here specifically.
      expect(result.isErr()).toBe(true);
      if (!result.isErr()) return;
      expect(result.error).toBeInstanceOf(WorkflowFailedError);
      const cause = (result.error as WorkflowFailedError).cause;
      expect(cause).toBeInstanceOf(ApplicationFailure);
      expect((cause as ApplicationFailure).type).toBe("ContractMisuseError");
      expect((cause as ApplicationFailure).message).toContain(
        "the input schema validates asynchronously",
      );
    });
  });

  it("schema-probe edge cases: a synchronous throw passes the bind probe; probe-dodging and thenable-dodging schemas still trip the per-call guard", async ({
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
        .startWorkflow("probeEdgeCases", { workflowId: "handlers-probe-edge-cases", args: {} })
        .getOrThrow();

      // `syncThrowProbe`'s schema throws SYNCHRONOUSLY when fed the
      // bind-time probe's opaque (symbol) sentinel — that throw must count
      // as "fine, it's synchronous", not a probe failure. EFFECT: bind
      // succeeded (the workflow is alive to answer a real query below) and
      // the schema still validates a real string payload correctly.
      const echoed = await handle.queries.syncThrowProbe("hello").getOrThrow();
      expect(echoed).toEqual({ echoed: "hello" });

      // `probeDodging` answers the bind-time probe SYNCHRONOUSLY (fed the
      // sentinel) but validates any REAL payload ASYNCHRONOUSLY —
      // undetectable at bind time. EFFECT: the PER-CALL guard (defense in
      // depth) still trips instead of silently corrupting query semantics.
      let probeDodgingRejected: unknown;
      try {
        await handle.raw.query("probeDodging", "hello");
      } catch (error) {
        probeDodgingRejected = error;
      }
      // Temporal classifies this failure mode as `QueryNotRegisteredError`
      // (unlike `describe`'s `QueryInputValidationError` failure above,
      // which stays a raw `ServiceError`) — the SDK's own message carries
      // the per-call guard's exact text.
      expect(probeDodgingRejected).toBeInstanceOf(QueryNotRegisteredError);
      expect((probeDodgingRejected as QueryNotRegisteredError).message).toBe(
        'Query "probeDodging" validation must be synchronous. Use a schema library that supports synchronous validation for queries.',
      );

      // `thenableDodging` is the same dodge, but its async result is a bare
      // `PromiseLike` rather than a native `Promise`. Proves the per-call
      // guard's structural `isThenable` check — not an `instanceof Promise`
      // check, which this would defeat — is what actually catches it.
      let thenableDodgingRejected: unknown;
      try {
        await handle.raw.query("thenableDodging", "hello");
      } catch (error) {
        thenableDodgingRejected = error;
      }
      expect(thenableDodgingRejected).toBeInstanceOf(QueryNotRegisteredError);
      expect((thenableDodgingRejected as QueryNotRegisteredError).message).toBe(
        'Query "thenableDodging" validation must be synchronous. Use a schema library that supports synchronous validation for queries.',
      );
    });
  });

  it("signal handler receives the parsed input (transform applied once)", async ({ testEnv }) => {
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
        .startWorkflow("transformWorkflow", { workflowId: "handlers-wire-signal", args: {} })
        .getOrThrow();

      await handle.signals.note({ text: "hi" });

      // EFFECT: the handler stored the PARSED (transformed) value — if the
      // transform were applied twice (or not at all), this would read
      // "hi!!" (or "hi") instead of "hi!".
      const peeked = await handle.queries.peekNote().getOrThrow();
      expect(peeked).toEqual({ text: "hi!" });
    });
  });

  it("query handler receives the parsed input; its original return crosses the wire untransformed", async ({
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
        .startWorkflow("transformWorkflow", { workflowId: "handlers-wire-query", args: {} })
        .getOrThrow();

      // `handle.raw.query` is used deliberately here, NOT to bypass a
      // rejection (the input `{ text: "hi" }` is perfectly valid) but
      // because our OWN typed client would re-parse the RECEIVED output on
      // our behalf, applying `n`'s `* 2` transform and hiding whether the
      // WORKER itself already (incorrectly) applied it. `raw` shows the
      // literal value the worker put on the wire.
      const raw = await handle.raw.query("peekText", { text: "hi" });

      // EFFECT: `receivedText` proves the handler received the PARSED
      // input ("hi!", not "hi"); `n: 21` (not `42`) proves the handler's
      // ORIGINAL return crossed the wire untransformed — the receiver (the
      // client, on a normal call) applies the output transform exactly
      // once, on receive.
      expect(raw).toEqual({ receivedText: "hi!", n: 21 });
    });
  });

  it("update handler receives the parsed input; its original return crosses the wire untransformed", async ({
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
        .startWorkflow("transformWorkflow", { workflowId: "handlers-wire-update", args: {} })
        .getOrThrow();

      const raw = await handle.raw.executeUpdate("poke", { args: [{ text: "hi" }] });

      expect(raw).toEqual({ receivedText: "hi!", n: 21 });
    });
  });
});
