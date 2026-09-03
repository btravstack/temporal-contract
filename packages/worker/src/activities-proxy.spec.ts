import type { ActivityDefinition } from "@temporal-contract/contract";
import { type AnyContractError, ContractError } from "@temporal-contract/contract/errors";
import {
  ActivityFailure,
  ApplicationFailure,
  CancelledFailure,
  RetryState,
} from "@temporalio/common";
import type { AsyncResult } from "unthrown";
/**
 * Runtime coverage for `createValidatedActivities` — the Result-shaped
 * wrapper every activity gets on the workflow side, declared `errors` map or
 * not: rehydration of declared `ApplicationFailure`s into typed
 * `ContractError`s (when the activity declares errors), cancellation
 * discrimination, and the `ActivityError` fallback for everything else.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createValidatedActivities } from "./activities-proxy.js";
import { ActivityCancelledError, type ActivityError } from "./errors.js";

/**
 * The error union the Result-shaped proxy actually produces for activities
 * with a declared `errors` map — typed rehydrations plus the two
 * classification fallbacks (see `createValidatedActivities`).
 */
type ProxyError = AnyContractError | ActivityError | ActivityCancelledError;

/**
 * The error union for activities with NO declared `errors` map — mirrors
 * `ActivityErrorsFor`'s else-branch in activities-proxy.ts: the same two
 * classification fallbacks as `ProxyError`, minus the typed rehydration
 * member that can't occur without a declared `errors` map.
 */
type NoDeclaredErrors = ActivityError | ActivityCancelledError;

const erroredDefinition = {
  input: z.object({ amount: z.number() }),
  output: z.object({ transactionId: z.string() }),
  errors: {
    PaymentDeclined: {
      data: z.object({ reason: z.string() }),
      nonRetryable: true,
    },
  },
} as unknown as ActivityDefinition;

const plainDefinition = {
  input: z.object({ amount: z.number() }),
  output: z.object({ transactionId: z.string() }),
} as unknown as ActivityDefinition;

const buildProxy = (raw: (...args: unknown[]) => Promise<unknown>) =>
  createValidatedActivities(
    { chargePayment: raw },
    { chargePayment: erroredDefinition },
    undefined,
  ) as unknown as Record<string, (input: unknown) => AsyncResult<unknown, ProxyError>>;

describe("createValidatedActivities — activities without declared errors", () => {
  it("is Result-shaped too — no more special throwing shape for undeclared errors", async () => {
    const activities = createValidatedActivities(
      { chargePayment: async () => ({ transactionId: "tx" }) },
      { chargePayment: plainDefinition },
      undefined,
    ) as unknown as Record<string, (input: unknown) => AsyncResult<unknown, NoDeclaredErrors>>;

    const okResult = await activities["chargePayment"]!({ amount: 1 });
    expect(okResult).toBeOkWith({ transactionId: "tx" });

    const errResult = await activities["chargePayment"]!({ amount: "bad" });
    expect(errResult).toBeErrTagged("@temporal-contract/ActivityError");
    if (errResult.isErr()) {
      expect(errResult.error.message).toContain("input validation failed");
    }
  });
});

describe("createValidatedActivities — wire format (validate on send, parse on receive)", () => {
  // D1: the workflow-side proxy is the SENDING side of the activity-input
  // boundary — it validates (fail early) but transmits the caller's ORIGINAL
  // value; the activity worker parses it once on receive. For the result it
  // is the RECEIVING side — the activity returned its original value, so the
  // proxy applies the output transform exactly once.
  const transformDefinition = {
    input: z.object({ text: z.string().transform((s: string) => `${s}!`) }),
    output: z.object({ n: z.number().transform((n: number) => n * 2) }),
  } as unknown as ActivityDefinition;

  const transformErroredDefinition = {
    ...transformDefinition,
    errors: {
      SomethingDeclined: { data: z.object({ reason: z.string() }) },
    },
  } as unknown as ActivityDefinition;

  it("no declared errors: sends the ORIGINAL input over the wire and parses the output once", async () => {
    const seen: unknown[] = [];
    const activities = createValidatedActivities(
      {
        transformer: async (input: unknown) => {
          seen.push(input);
          return { n: 21 };
        },
      },
      { transformer: transformDefinition },
      undefined,
    ) as unknown as Record<string, (input: unknown) => AsyncResult<unknown, NoDeclaredErrors>>;

    const result = await activities["transformer"]!({ text: "hi" });

    // The raw Temporal proxy received the caller's original value, not the
    // parsed `{ text: "hi!" }` — the activity worker parses on receive.
    expect(seen).toEqual([{ text: "hi" }]);
    // The activity's wire value (pre-transform) is parsed exactly once here.
    expect(result).toBeOkWith({ n: 42 });
  });

  it("declared errors: sends the ORIGINAL input over the wire and parses the output once", async () => {
    const seen: unknown[] = [];
    const activities = createValidatedActivities(
      {
        transformer: async (input: unknown) => {
          seen.push(input);
          return { n: 21 };
        },
      },
      { transformer: transformErroredDefinition },
      undefined,
    ) as unknown as Record<string, (input: unknown) => AsyncResult<unknown, ProxyError>>;

    const result = await activities["transformer"]!({ text: "hi" });

    expect(seen).toEqual([{ text: "hi" }]);
    expect(result).toBeOkWith({ n: 42 });
  });
});

describe("createValidatedActivities — activities with declared errors", () => {
  it("returns Ok with the validated output on success", async () => {
    const activities = buildProxy(async () => ({ transactionId: "tx" }));

    const result = await activities["chargePayment"]!({ amount: 1 });
    expect(result).toBeOkWith({ transactionId: "tx" });
  });

  it("rehydrates a declared ApplicationFailure into a typed ContractError", async () => {
    const failure = ApplicationFailure.create({
      type: "PaymentDeclined",
      message: "Card declined",
      nonRetryable: true,
      details: [{ reason: "insufficient_funds" }],
    });
    const activities = buildProxy(async () => {
      throw failure;
    });

    const result = await activities["chargePayment"]!({ amount: 1 });
    expect(result).toBeErrTagged("@temporal-contract/ContractError");
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(ContractError);
      const error = result.error as InstanceType<typeof ContractError>;
      expect(error.errorName).toBe("PaymentDeclined");
      expect(error.data).toEqual({ reason: "insufficient_funds" });
      expect(error.cause).toBe(failure);
    }
  });

  it("surfaces an undeclared ApplicationFailure as ActivityError with the failure as cause", async () => {
    const failure = ApplicationFailure.create({ type: "GATEWAY_5XX", message: "boom" });
    const activities = buildProxy(async () => {
      throw failure;
    });

    const result = await activities["chargePayment"]!({ amount: 1 });
    expect(result).toBeErrTagged("@temporal-contract/ActivityError");
    if (result.isErr()) {
      const error = result.error as InstanceType<typeof ActivityError>;
      expect(error.activityName).toBe("chargePayment");
      expect(error.cause).toBe(failure);
    }
  });

  it("preserves the original ActivityFailure wrapper as ActivityError.originalFailure, alongside the unwrapped cause", async () => {
    // classifyActivityError unwraps Temporal's ActivityFailure to build
    // `cause` (the failure below only throws a bare ApplicationFailure, never
    // exercising that unwrap branch or the originalFailure argument at all —
    // this test drives a REAL ActivityFailure wrapper through the raw
    // activity so both are covered).
    const inner = ApplicationFailure.create({ type: "GATEWAY_5XX", message: "boom" });
    const wrapper = new ActivityFailure(
      "activity failed",
      "chargePayment",
      "1",
      RetryState.MAXIMUM_ATTEMPTS_REACHED,
      undefined,
      inner,
    );
    const activities = buildProxy(async () => {
      throw wrapper;
    });

    const result = await activities["chargePayment"]!({ amount: 1 });
    expect(result).toBeErrTagged("@temporal-contract/ActivityError");
    if (result.isErr()) {
      const error = result.error as InstanceType<typeof ActivityError>;
      // cause stays the UNWRAPPED failure (documented, unchanged behavior).
      expect(error.cause).toBe(inner);
      // originalFailure is the wrapper Temporal actually threw, retained
      // specifically so propagateFailure can re-raise it faithfully.
      expect(error.originalFailure).toBe(wrapper);
    }
  });

  it("surfaces a declared type with a mismatching payload as ActivityError (no wrong typed error)", async () => {
    const failure = ApplicationFailure.create({
      type: "PaymentDeclined",
      details: [{ reason: 42 }],
    });
    const activities = buildProxy(async () => {
      throw failure;
    });

    const result = await activities["chargePayment"]!({ amount: 1 });
    expect(result).toBeErrTagged("@temporal-contract/ActivityError");
  });

  it("discriminates cancellation as ActivityCancelledError", async () => {
    const activities = buildProxy(async () => {
      throw new CancelledFailure("workflow cancelled");
    });

    const result = await activities["chargePayment"]!({ amount: 1 });
    expect(result).toBeErrTagged("@temporal-contract/ActivityCancelledError");
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(ActivityCancelledError);
    }
  });

  it("preserves the original ActivityFailure wrapper on ActivityCancelledError.cause when cancellation is wrapped", async () => {
    // isCancellation() recognizes an ActivityFailure whose cause is a
    // CancelledFailure — the shape a real cancelled activity actually throws
    // (not the bare CancelledFailure the test above uses). Cancellation is
    // detected BEFORE classifyActivityError's unwrap, so cause here should be
    // the wrapper itself, not the inner CancelledFailure.
    const cancelledFailure = new CancelledFailure("activity cancelled");
    const wrapper = new ActivityFailure(
      "activity failed",
      "chargePayment",
      "1",
      RetryState.CANCEL_REQUESTED,
      undefined,
      cancelledFailure,
    );
    const activities = buildProxy(async () => {
      throw wrapper;
    });

    const result = await activities["chargePayment"]!({ amount: 1 });
    expect(result).toBeErrTagged("@temporal-contract/ActivityCancelledError");
    if (result.isErr()) {
      const error = result.error as InstanceType<typeof ActivityCancelledError>;
      expect(error.cause).toBe(wrapper);
    }
  });

  it("folds workflow-side input validation failure into Err(ActivityError)", async () => {
    const activities = buildProxy(async () => ({ transactionId: "tx" }));

    const result = await activities["chargePayment"]!({ amount: "bad" });
    expect(result).toBeErrTagged("@temporal-contract/ActivityError");
    if (result.isErr()) {
      expect((result.error as InstanceType<typeof ActivityError>).message).toContain(
        "input validation failed",
      );
    }
  });

  it("folds output validation failure into Err(ActivityError)", async () => {
    const activities = buildProxy(async () => ({ transactionId: 42 }));

    const result = await activities["chargePayment"]!({ amount: 1 });
    expect(result).toBeErrTagged("@temporal-contract/ActivityError");
    if (result.isErr()) {
      expect((result.error as InstanceType<typeof ActivityError>).message).toContain(
        "output validation failed",
      );
    }
  });
});
