/**
 * Coverage for `runActivity` — real `MockActivityEnvironment` (in-process,
 * no Docker): Ok/Err channels flow through untouched, typed error
 * constructors are built from the definition, unanticipated throws land on
 * the defect channel, and a caller-provided environment enables heartbeat
 * observation and cancellation.
 */
import { defineActivity } from "@temporal-contract/contract";
import { ContractError } from "@temporal-contract/contract/errors";
import { MockActivityEnvironment } from "@temporalio/testing";
import { ErrAsync, OkAsync, fromSafePromise } from "unthrown";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { runActivity } from "./activity.js";

const charge = defineActivity({
  input: z.object({ amount: z.number() }),
  output: z.object({ transactionId: z.string() }),
  errors: {
    PaymentDeclined: {
      data: z.object({ reason: z.string() }),
      nonRetryable: true,
    },
  },
  defaultOptions: { startToCloseTimeout: "10 seconds" },
});

describe("runActivity", () => {
  it("returns the implementation's Ok result", async () => {
    const result = await runActivity(
      charge,
      ({ amount }) => OkAsync({ transactionId: `TXN-${amount}` }),
      { amount: 42 },
    );

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toEqual({ transactionId: "TXN-42" });
    }
  });

  it("returns a typed contract error built with the errors helper", async () => {
    const result = await runActivity(
      charge,
      ({ amount }, { errors }) =>
        ErrAsync(errors.PaymentDeclined({ reason: `insufficient funds for ${amount}` })),
      { amount: 9000 },
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(ContractError);
      expect(result.error.errorName).toBe("PaymentDeclined");
      expect(result.error.data).toEqual({ reason: "insufficient funds for 9000" });
    }
  });

  it("surfaces an unanticipated throw on the defect channel", async () => {
    const boom = new Error("boom");
    const result = await runActivity(
      charge,
      () => {
        throw boom;
      },
      { amount: 1 },
    );

    expect(result.isDefect()).toBe(true);
    if (result.isDefect()) {
      expect(result.cause).toBe(boom);
    }
  });

  it("runs in the provided environment, so heartbeats are observable", async () => {
    const env = new MockActivityEnvironment();
    const heartbeats: unknown[] = [];
    env.on("heartbeat", (details: unknown) => heartbeats.push(details));

    const result = await runActivity(
      charge,
      ({ amount }) => {
        // Inside `env.run`, `Context.current()` is this environment's
        // context — the mock env instance exposes it as `env.context`.
        env.context.heartbeat("halfway");
        return OkAsync({ transactionId: `TXN-${amount}` });
      },
      { amount: 7 },
      { env },
    );

    expect(result.isOk()).toBe(true);
    expect(heartbeats).toEqual(["halfway"]);
  });

  it("surfaces cancellation as a defect", async () => {
    const env = new MockActivityEnvironment();

    const resultPromise = runActivity(
      charge,
      () =>
        // Resolves only via rejection: `context.cancelled` rejects with a
        // CancelledFailure once `env.cancel()` fires — an unmodeled throw,
        // hence a defect.
        fromSafePromise(env.context.cancelled.then(() => ({ transactionId: "never" }))),
      { amount: 1 },
      { env },
    );

    env.cancel();
    const result = await resultPromise;

    expect(result.isDefect()).toBe(true);
    if (result.isDefect()) {
      expect(result.cause).toMatchObject({ name: "CancelledFailure" });
    }
  });
});
