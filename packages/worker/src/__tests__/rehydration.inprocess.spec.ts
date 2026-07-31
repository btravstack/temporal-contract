import { extname } from "node:path";
import { fileURLToPath } from "node:url";

import { ContractError, TypedClient } from "@temporal-contract/client";
import { onRehydrationMiss, type RehydrationMiss } from "@temporal-contract/contract/errors";
import { it } from "@temporal-contract/testing/time-skipping";
import { OkAsync, ErrAsync } from "unthrown";
/**
 * E2e coverage for the two rehydration audit gaps (in-process, no Docker):
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
 */
import { describe, expect } from "vitest";

import { ApplicationFailure, declareActivitiesHandler } from "../activity.js";
import { TypedWorker } from "../worker.js";
import { rehydrationClientContract, rehydrationWorkerContract } from "./rehydration.contract.js";

const activities = declareActivitiesHandler({
  contract: rehydrationWorkerContract,
  activities: {
    quote: {
      charge: ({ mode }, { errors }) => {
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

function workflowPath(filename: string): string {
  return fileURLToPath(new URL(`./${filename}${extname(import.meta.url)}`, import.meta.url));
}

describe("rehydration at the e2e boundary", () => {
  it("does not rehydrate a marker-less ApplicationFailure as a data-less declared error", async ({
    testEnv,
  }) => {
    const worker = await TypedWorker.create({
      contract: rehydrationWorkerContract,
      connection: testEnv.nativeConnection,
      workflowsPath: workflowPath("rehydration.workflows"),
      activities,
    }).get();

    const typedClient = await TypedClient.create({ client: testEnv.client }).get();
    const client = typedClient.for(rehydrationWorkerContract);

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
    const worker = await TypedWorker.create({
      contract: rehydrationWorkerContract,
      connection: testEnv.nativeConnection,
      workflowsPath: workflowPath("rehydration.workflows"),
      activities,
    }).get();

    const typedClient = await TypedClient.create({ client: testEnv.client }).get();
    const workerSideClient = typedClient.for(rehydrationWorkerContract);
    const skewedClient = typedClient.for(rehydrationClientContract);

    const misses: RehydrationMiss[] = [];
    onRehydrationMiss((miss) => misses.push(miss));
    try {
      await worker.raw.runUntil(async () => {
        // Control: with matching schemas the failure rehydrates into the
        // typed error, data parsed against the declared schema.
        const matching = await workerSideClient.executeWorkflow("quote", {
          workflowId: "rehydration-skew-control",
          args: { mode: "expired" },
        });
        expect(matching).toBeErrTagged("@temporal-contract/ContractError");
        if (matching.isErr() && matching.error instanceof ContractError) {
          expect(matching.error.errorName).toBe("QuoteExpired");
          expect(matching.error.data).toEqual({ quoteId: "legacy-1" });
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
