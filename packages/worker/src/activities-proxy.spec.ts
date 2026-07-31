import type { ActivityDefinition } from "@temporal-contract/contract";
import { type AnyContractError, ContractError } from "@temporal-contract/contract/errors";
import { ApplicationFailure, CancelledFailure } from "@temporalio/common";
import type { AsyncResult } from "unthrown";
/**
 * Runtime coverage for `createValidatedActivities` — specifically the
 * Result-shaped wrapper that activities with a declared `errors` map get on
 * the workflow side: rehydration of declared `ApplicationFailure`s into
 * typed `ContractError`s, cancellation discrimination, and the
 * `ActivityError` fallback for everything else.
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
  it("keeps the historical throwing Promise shape", async () => {
    const activities = createValidatedActivities(
      { chargePayment: async () => ({ transactionId: "tx" }) },
      { chargePayment: plainDefinition },
      undefined,
    ) as unknown as Record<string, (input: unknown) => Promise<unknown>>;

    await expect(activities["chargePayment"]!({ amount: 1 })).resolves.toEqual({
      transactionId: "tx",
    });
    await expect(activities["chargePayment"]!({ amount: "bad" })).rejects.toThrow(
      /input validation failed/,
    );
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

  it("throwing shape: sends the ORIGINAL input over the wire and parses the output once", async () => {
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
    ) as unknown as Record<string, (input: unknown) => Promise<unknown>>;

    const result = await activities["transformer"]!({ text: "hi" });

    // The raw Temporal proxy received the caller's original value, not the
    // parsed `{ text: "hi!" }` — the activity worker parses on receive.
    expect(seen).toEqual([{ text: "hi" }]);
    // The activity's wire value (pre-transform) is parsed exactly once here.
    expect(result).toEqual({ n: 42 });
  });

  it("Result shape: sends the ORIGINAL input over the wire and parses the output once", async () => {
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
