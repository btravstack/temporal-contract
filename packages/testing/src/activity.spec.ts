/**
 * Coverage for `runActivity` and `runActivityHandler` — real
 * `MockActivityEnvironment` (in-process, no Docker).
 *
 * `runActivity` (pure-logic tier): Ok/Err channels flow through untouched,
 * typed error constructors are built from the definition, unanticipated
 * throws land on the defect channel, and a caller-provided environment
 * enables heartbeat observation and cancellation.
 *
 * `runActivityHandler` (boundary-faithful tier): the same implementations
 * routed through the real `declareActivitiesHandler` wrapping — the three
 * failure modes `runActivity` hides (invalid error data, output drift,
 * undeclared error names) surface the production terminal failures, and a
 * declared error round-trips the wire (ApplicationFailure + marker) back
 * into a typed `ContractError`.
 */
import { defineActivity } from "@temporal-contract/contract";
import { ContractError } from "@temporal-contract/contract/errors";
import {
  ApplicationFailure,
  ContractErrorDataValidationError,
  ActivityInputValidationError,
  ActivityOutputValidationError,
} from "@temporal-contract/worker/activity";
import { MockActivityEnvironment } from "@temporalio/testing";
import { ErrAsync, OkAsync, fromSafePromise } from "unthrown";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { runActivity, runActivityHandler } from "./activity.js";

const charge = defineActivity({
  input: z.object({ amount: z.number() }),
  output: z.object({ transactionId: z.string() }),
  errors: {
    PaymentDeclined: {
      data: z.object({ reason: z.string() }),
      nonRetryable: true,
    },
  },
  activityOptions: { startToCloseTimeout: "10 seconds" },
});

describe("runActivity", () => {
  it("returns the implementation's Ok result", async () => {
    const result = await runActivity(charge, {
      implementation: (_, { amount }) => OkAsync({ transactionId: `TXN-${amount}` }),
      input: { amount: 42 },
    });

    expect(result).toBeOkWith({ transactionId: "TXN-42" });
  });

  it("returns a typed contract error built with the errors helper", async () => {
    const result = await runActivity(charge, {
      implementation: ({ errors }, { amount }) =>
        ErrAsync(errors.PaymentDeclined({ reason: `insufficient funds for ${amount}` })),
      input: { amount: 9000 },
    });

    expect(result).toBeErrTagged("@temporal-contract/ContractError");
    if (result.isErr()) {
      expect(result.error.errorName).toBe("PaymentDeclined");
      expect(result.error.data).toEqual({ reason: "insufficient funds for 9000" });
    }
  });

  it("surfaces an unanticipated throw on the defect channel", async () => {
    const boom = new Error("boom");
    const result = await runActivity(charge, {
      implementation: () => {
        throw boom;
      },
      input: { amount: 1 },
    });

    expect(result).toBeDefect();
    if (result.isDefect()) {
      expect(result.cause).toBe(boom);
    }
  });

  it("runs in the provided environment, so heartbeats are observable", async () => {
    const env = new MockActivityEnvironment();
    const heartbeats: unknown[] = [];
    env.on("heartbeat", (details: unknown) => heartbeats.push(details));

    const result = await runActivity(charge, {
      implementation: (_, { amount }) => {
        // Inside `env.run`, `Context.current()` is this environment's
        // context — the mock env instance exposes it as `env.context`.
        env.context.heartbeat("halfway");
        return OkAsync({ transactionId: `TXN-${amount}` });
      },
      input: { amount: 7 },
      env,
    });

    expect(result).toBeOk();
    expect(heartbeats).toEqual(["halfway"]);
  });

  it("surfaces cancellation as a defect", async () => {
    const env = new MockActivityEnvironment();

    const resultPromise = runActivity(charge, {
      implementation: () =>
        // Resolves only via rejection: `context.cancelled` rejects with a
        // CancelledFailure once `env.cancel()` fires — an unmodeled throw,
        // hence a defect.
        fromSafePromise(env.context.cancelled.then(() => ({ transactionId: "never" }))),
      input: { amount: 1 },
      env,
    });

    env.cancel();
    const result = await resultPromise;

    expect(result).toBeDefect();
    if (result.isDefect()) {
      expect(result.cause).toMatchObject({ name: "CancelledFailure" });
    }
  });
});

describe("runActivityHandler", () => {
  it("round-trips an Ok output through the real wrapping (input parsed, output validated)", async () => {
    const seen: unknown[] = [];
    const result = await runActivityHandler(charge, {
      implementation: (_, args) => {
        seen.push(args);
        return OkAsync({ transactionId: `TXN-${args.amount}` });
      },
      input: { amount: 42 },
    });

    expect(result).toBeOkWith({ transactionId: "TXN-42" });
    // The handler parsed the wire input before handing it over.
    expect(seen).toEqual([{ amount: 42 }]);
  });

  it("round-trips a declared error over the wire and rehydrates the typed ContractError", async () => {
    const result = await runActivityHandler(charge, {
      implementation: ({ errors }, { amount }) =>
        ErrAsync(errors.PaymentDeclined({ reason: `declined-${amount}` })),
      input: { amount: 9 },
    });

    expect(result).toBeErrTagged("@temporal-contract/ContractError");
    if (result.isErr() && result.error instanceof ContractError) {
      expect(result.error.errorName).toBe("PaymentDeclined");
      expect(result.error.data).toEqual({ reason: "declined-9" });
      // The rehydrated error's cause is the wire ApplicationFailure carrying
      // the provenance marker at details[1].
      const failure = result.error.cause as ApplicationFailure;
      expect(failure).toBeInstanceOf(ApplicationFailure);
      expect(failure.type).toBe("PaymentDeclined");
      expect(failure.nonRetryable).toBe(true);
      expect(failure.details?.[1]).toEqual({ $tc: 1 });
    }
  });

  it("surfaces error data that violates the declared schema as the production terminal failure", async () => {
    // runActivity would return this Err untouched (a green test); the real
    // boundary rejects the contract misuse terminally.
    const result = await runActivityHandler(charge, {
      implementation: ({ errors }) =>
        ErrAsync(errors.PaymentDeclined({ reason: 42 as unknown as string })),
      input: { amount: 1 },
    });

    expect(result).toBeErr();
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(ContractErrorDataValidationError);
      if (result.error instanceof ContractErrorDataValidationError) {
        expect(result.error.nonRetryable).toBe(true);
        expect(result.error.message).toContain('Contract error "PaymentDeclined"');
      }
    }
  });

  it("surfaces output drifting from the output schema as ActivityOutputValidationError", async () => {
    const result = await runActivityHandler(charge, {
      implementation: () => OkAsync({ transactionId: 123 } as unknown as { transactionId: string }),
      input: { amount: 1 },
    });

    expect(result).toBeErr();
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(ActivityOutputValidationError);
      expect(result.error.message).toContain("output validation failed");
    }
  });

  it("surfaces an undeclared error name as the production contract-misuse failure", async () => {
    const result = await runActivityHandler(charge, {
      implementation: () =>
        ErrAsync(
          new ContractError({
            errorName: "NotDeclared",
            data: undefined,
            message: "smuggled past the contract",
          }),
        ),
      input: { amount: 1 },
    });

    expect(result).toBeErr();
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(ContractErrorDataValidationError);
      expect(result.error.message).toContain('"NotDeclared" is not declared');
    }
  });

  it("parses the wire input like production — invalid input fails before the implementation runs", async () => {
    let invoked = false;
    const result = await runActivityHandler(charge, {
      implementation: () => {
        invoked = true;
        return OkAsync({ transactionId: "never" });
      },
      input: { amount: "bad" } as unknown as { amount: number },
    });

    expect(invoked).toBe(false);
    expect(result).toBeErr();
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(ActivityInputValidationError);
    }
  });

  it("keeps an Err(ApplicationFailure) as the raw failure (no rehydration)", async () => {
    const failure = ApplicationFailure.create({ type: "GATEWAY_5XX", message: "boom" });
    const result = await runActivityHandler(charge, {
      implementation: () => ErrAsync(failure),
      input: { amount: 1 },
    });

    expect(result).toBeErr();
    if (result.isErr()) {
      expect(result.error).toBe(failure);
    }
  });

  it("keeps unanticipated throws on the defect channel", async () => {
    const boom = new Error("boom");
    const result = await runActivityHandler(charge, {
      implementation: () => {
        throw boom;
      },
      input: { amount: 1 },
    });

    expect(result).toBeDefect();
    if (result.isDefect()) {
      expect(result.cause).toBe(boom);
    }
  });
});
