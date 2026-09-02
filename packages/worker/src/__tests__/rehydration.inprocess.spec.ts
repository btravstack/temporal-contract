import { ContractError, TypedClient, WorkflowFailedError } from "@temporal-contract/client";
import { onRehydrationMiss, type RehydrationMiss } from "@temporal-contract/contract/errors";
import { testRig } from "@temporal-contract/testing/test-rig";
import { it } from "@temporal-contract/testing/time-skipping";
import {
  bundleFor,
  fixturePath,
  nextTaskQueueId,
  withTaskQueue,
} from "@temporal-contract/testing/workflow-bundle";
import { OkAsync, ErrAsync } from "unthrown";
/**
 * E2e coverage for the two rehydration audit gaps (in-process, no Docker),
 * in `describe("rehydration at the e2e boundary", ...)` below:
 *
 * 1. **Contract skew** — a worker emits a declared error whose data is valid
 *    against the worker's schema but fails a STRICTER client-side schema:
 *    the client must degrade to the generic `WorkflowFailedError` (never a
 *    wrongly-typed `ContractError`) and the `onRehydrationMiss` diagnostic
 *    hook must fire with `reason: "data-validation-failed"`.
 * 2. **Rehydration false-positive regression** — an `ApplicationFailure`
 *    carrying a declared *data-less* error's name as its `type` but WITHOUT
 *    the wire marker (e.g. built with plain `ApplicationFailure.create` in
 *    an activity) must NOT rehydrate as the typed error on the workflow
 *    side; only the marker-carrying failure produced by the typed
 *    constructors does.
 *
 * A separate `describe("declareWorkflow — contract-error conversion", ...)`
 * below covers `declareWorkflow`'s error-conversion boundary — the catch
 * block wrapping a workflow `implementation` that turns a thrown
 * `context.errors.X(...)` into the `ApplicationFailure` wire shape (see
 * `../workflow.ts`):
 *
 * a. A thrown contract error whose data fails its OWN declared schema fails
 *    fast with `ContractErrorDataValidationError` rather than crossing the
 *    wire malformed.
 * b. A thrown error that is NOT a `ContractError` (e.g. a hand-built
 *    `ApplicationFailure`) is rethrown untouched — not misclassified, not
 *    swallowed.
 */
import { describe, expect } from "vitest";

import { ApplicationFailure, declareActivitiesHandler } from "../activity.js";
import { rehydrationClientContract, rehydrationWorkerContract } from "./rehydration.contract.js";

const activities = declareActivitiesHandler({
  contract: rehydrationWorkerContract,
  activities: {
    quote: {
      charge: ({ errors }, { mode }) => {
        if (mode === "fake-typed") {
          // A plain ApplicationFailure that reuses the declared data-less
          // error name as its `type` — no wire marker. `nonRetryable` so the
          // failure surfaces immediately instead of exhausting retries.
          return ErrAsync(
            ApplicationFailure.create({
              type: "AlreadyCharged",
              message: "raw failure impersonating a declared name",
              nonRetryable: true,
            }),
          );
        }
        if (mode === "typed") {
          // The genuine typed constructor — converted at the boundary with
          // the wire marker at details[1].
          return ErrAsync(errors.AlreadyCharged());
        }
        return OkAsync({ ok: true });
      },
    },
  },
});

describe("rehydration at the e2e boundary", () => {
  it("does not rehydrate a marker-less ApplicationFailure as a data-less declared error", async ({
    testEnv,
  }) => {
    const contract = withTaskQueue(rehydrationWorkerContract, nextTaskQueueId("rehydration"));
    const bundle = await bundleFor(fixturePath(import.meta.url, "rehydration.workflows"));

    const { worker, client } = await testRig(testEnv, { contract, bundle, activities });

    await worker.raw.runUntil(async () => {
      // Control: the typed constructor's failure carries the marker and DOES
      // rehydrate into the typed ContractError on the workflow side.
      const typed = await client.executeWorkflow("quote", {
        workflowId: "rehydration-typed",
        args: { mode: "typed" },
      });
      expect(typed).toBeOkWith({ classification: "contract:AlreadyCharged" });

      // Regression: same `type` string, no marker — must degrade to the
      // generic ActivityError, not the typed error.
      const fake = await client.executeWorkflow("quote", {
        workflowId: "rehydration-fake-typed",
        args: { mode: "fake-typed" },
      });
      expect(fake).toBeOkWith({ classification: "generic:@temporal-contract/ActivityError" });
    });
  });

  it("degrades to the generic failure and fires onRehydrationMiss when the client schema is stricter", async ({
    testEnv,
  }) => {
    const queueId = nextTaskQueueId("rehydration");
    const workerContract = withTaskQueue(rehydrationWorkerContract, queueId);
    const clientContract = withTaskQueue(rehydrationClientContract, queueId);
    const bundle = await bundleFor(fixturePath(import.meta.url, "rehydration.workflows"));

    // Two contract views of the same worker (worker-side and client-side
    // schema skew), so `testRig` — which binds one client to one contract —
    // only covers the worker-side half; `skewedClient` is a second,
    // independent `TypedClient` bound to `clientContract` on top of it.
    const { worker, client: workerSideClient } = await testRig(testEnv, {
      contract: workerContract,
      bundle,
      activities,
    });

    const typedClient = await TypedClient.create({ client: testEnv.client }).get();
    const skewedClient = typedClient.for(clientContract);

    const misses: RehydrationMiss[] = [];
    onRehydrationMiss((miss) => misses.push(miss));
    try {
      await worker.raw.runUntil(async () => {
        // Control: with matching schemas the failure rehydrates into the
        // typed error, data parsed against the declared schema — and the
        // contract-declared `message` survives the workflow → wire →
        // client-rehydration round trip.
        const matching = await workerSideClient.executeWorkflow("quote", {
          workflowId: "rehydration-skew-control",
          args: { mode: "expired" },
        });
        expect(matching).toBeErrTagged("@temporal-contract/ContractError");
        if (matching.isErr() && matching.error instanceof ContractError) {
          expect(matching.error.errorName).toBe("QuoteExpired");
          expect(matching.error.data).toEqual({ quoteId: "legacy-1" });
          expect(matching.error.message).toBe("Quote has expired");

          // The raw wire failure, preserved on `.cause` (rehydration assigns
          // it there — see `_internal_rehydrateContractError`). `nonRetryable`
          // has no ContractError-level surface, and the wire marker at
          // `details[1]` is NOT gated on for a data-carrying error like
          // `QuoteExpired` (`_internal_rehydrateContractError`'s
          // `hasWireMarker` check only runs in the data-LESS `else if`
          // branch) — so without this, a regression that stopped the
          // workflow boundary from emitting the marker would still pass
          // every other assertion in this file.
          const raw = matching.error.cause as ApplicationFailure;
          expect(raw.message).toBe("Quote has expired");
          expect(raw.nonRetryable).toBe(true);
          expect(raw.details).toEqual([{ quoteId: "legacy-1" }, { $tc: 1 }]);
        }

        // Skew: the stricter client-side schema rejects the (worker-valid)
        // data — the result degrades to the generic WorkflowFailedError
        // instead of surfacing a wrongly-typed ContractError.
        const skewed = await skewedClient.executeWorkflow("quote", {
          workflowId: "rehydration-skew",
          args: { mode: "expired" },
        });
        expect(skewed).toBeErrTagged("@temporal-contract/WorkflowFailedError");
      });

      // The degrade was observable: the diagnostic hook reported the miss.
      expect(misses).toEqual([
        expect.objectContaining({
          errorName: "QuoteExpired",
          reason: "data-validation-failed",
        }),
      ]);
    } finally {
      onRehydrationMiss(undefined);
    }
  });
});

describe("declareWorkflow — contract-error conversion", () => {
  it("fails fast when the thrown error's data does not validate against its own schema", async ({
    testEnv,
  }) => {
    const contract = withTaskQueue(rehydrationWorkerContract, nextTaskQueueId("rehydration"));
    const bundle = await bundleFor(fixturePath(import.meta.url, "rehydration.workflows"));

    const { worker, client } = await testRig(testEnv, { contract, bundle, activities });

    await worker.raw.runUntil(async () => {
      const result = await client.executeWorkflow("quote", {
        workflowId: "rehydration-bad-data",
        args: { mode: "bad-data" },
        // Bound: a regression that let this hang (e.g. reverting to a plain
        // `throw` that Temporal retries as a Workflow Task failure forever)
        // must fail fast, not ride the 120s suite timeout.
        workflowExecutionTimeout: "30 seconds",
      });

      // EFFECT: the execution fails terminally with the deterministic
      // contract-misuse failure — never rehydrated as `QuoteExpired` (its
      // data never validated) and never left `Running`.
      expect(result.isErr()).toBe(true);
      if (!result.isErr()) return;
      expect(result.error).toBeInstanceOf(WorkflowFailedError);
      const cause = (result.error as WorkflowFailedError).cause;
      expect(cause).toBeInstanceOf(ApplicationFailure);
      expect((cause as ApplicationFailure).type).toBe("ContractErrorDataValidationError");
      expect((cause as ApplicationFailure).nonRetryable).toBe(true);
    });
  });

  it("leaves a thrown error that is not a ContractError untouched", async ({ testEnv }) => {
    const contract = withTaskQueue(rehydrationWorkerContract, nextTaskQueueId("rehydration"));
    const bundle = await bundleFor(fixturePath(import.meta.url, "rehydration.workflows"));

    const { worker, client } = await testRig(testEnv, { contract, bundle, activities });

    await worker.raw.runUntil(async () => {
      const result = await client.executeWorkflow("quote", {
        workflowId: "rehydration-boom",
        args: { mode: "boom" },
        workflowExecutionTimeout: "30 seconds",
      });

      // EFFECT: the hand-built `ApplicationFailure` crosses the wire with
      // its own `type`/`message`/`nonRetryable` intact — proving
      // `declareWorkflow`'s catch block rethrew it rather than routing it
      // through the contract-error conversion (which would have thrown
      // `ContractErrorDataValidationError` for an undeclared name) or
      // swallowing it into a generic failure.
      expect(result.isErr()).toBe(true);
      if (!result.isErr()) return;
      expect(result.error).toBeInstanceOf(WorkflowFailedError);
      const cause = (result.error as WorkflowFailedError).cause;
      expect(cause).toBeInstanceOf(ApplicationFailure);
      expect((cause as ApplicationFailure).type).toBe("SOMETHING_ELSE");
      expect((cause as ApplicationFailure).message).toBe("boom");
      expect((cause as ApplicationFailure).nonRetryable).toBe(true);
    });
  });
});
