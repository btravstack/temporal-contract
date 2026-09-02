import { defineActivity, defineContract, defineWorkflow } from "@temporal-contract/contract";
import { z } from "zod";

/**
 * A three-step fulfilment whose last step fails, plus the two activities that
 * take the first two back. `mode` chooses how the last step fails, which is
 * the only variable the saga's policy reads.
 */
const reserve = defineActivity({
  input: z.object({}),
  output: z.object({ reservationId: z.string() }),
  activityOptions: { retry: { maximumAttempts: 1 } },
});

const charge = defineActivity({
  input: z.object({ sleepMs: z.number() }),
  output: z.object({ chargeId: z.string() }),
  // Temporal delivers a cancellation notification only in the response to a
  // heartbeat RPC, so `cancelled` is unobservable without this.
  activityOptions: { heartbeatTimeout: "2 seconds", retry: { maximumAttempts: 1 } },
});

/**
 * `declared` answers the contract error the walk-back exists for; `unmodelled`
 * fails as an `ActivityError`, which must leave the earlier steps standing.
 */
const ship = defineActivity({
  input: z.object({ mode: z.enum(["declared", "unmodelled"]) }),
  output: z.object({ shipmentId: z.string() }),
  errors: {
    OutOfStock: { data: z.object({ sku: z.string() }), nonRetryable: true },
  },
  activityOptions: { retry: { maximumAttempts: 1 } },
});

const release = defineActivity({
  input: z.object({}),
  output: z.object({}),
  activityOptions: { retry: { maximumAttempts: 1 } },
});

const refund = defineActivity({
  input: z.object({}),
  output: z.object({}),
  activityOptions: { retry: { maximumAttempts: 1 } },
});

const fulfil = defineWorkflow({
  input: z.object({ mode: z.enum(["declared", "unmodelled"]) }),
  output: z.object({ failedWith: z.string() }),
  idempotency: "allow-duplicate",
  activities: { ship, refund },
});

/**
 * The `compensateOnCancellation` branch: step two blocks until the workflow
 * is cancelled, and the undo of step one must still run — which it can only
 * do from a non-cancellable scope, since a cancelled scope schedules nothing.
 */
const fulfilUntilCancelled = defineWorkflow({
  input: z.object({}),
  output: z.object({ failedWith: z.string() }),
  idempotency: "allow-duplicate",
  activities: {},
});

export const sagaContract = defineContract({
  taskQueue: "saga-tests",
  // `reserve`, `charge` and `release` are global: both workflows use them, and
  // activities share one flat namespace at runtime, so a per-workflow copy
  // would be two implementations of one name.
  activities: { reserve, charge, release },
  workflows: { fulfil, fulfilUntilCancelled },
});
