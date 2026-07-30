import { defineContract } from "@temporal-contract/contract";
import { ContractError } from "@temporal-contract/contract/errors";
import { OkAsync, ErrAsync, P } from "unthrown";
/**
 * Runtime coverage for `declareActivitiesHandler`'s contract-declared typed
 * errors, middleware chain, and dependency context — the boundary where an
 * implementation's `Err(ContractError)` becomes a Temporal
 * `ApplicationFailure` (`type` = error name, `details[0]` = validated data,
 * `nonRetryable` from the contract).
 */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  ApplicationFailure,
  composeActivityMiddleware,
  declareActivitiesHandler,
  declareActivityMiddleware,
  type ActivityMiddleware,
} from "./activity.js";
import { ContractErrorDataValidationError } from "./errors.js";

const contract = defineContract({
  taskQueue: "test-queue",
  workflows: {
    processOrder: {
      input: z.object({}),
      output: z.object({}),
      activities: {
        chargePayment: {
          input: z.object({ amount: z.number() }),
          output: z.object({ transactionId: z.string() }),
          errors: {
            PaymentDeclined: {
              data: z.object({ reason: z.string() }),
              message: "The payment was declined",
              nonRetryable: true,
            },
            GatewayUnavailable: {},
          },
        },
      },
    },
  },
  activities: {
    sendEmail: {
      input: z.object({ to: z.string() }),
      output: z.object({ sent: z.boolean() }),
    },
  },
});

describe("declareActivitiesHandler — contract errors", () => {
  it("converts a typed error into an ApplicationFailure with contract semantics", async () => {
    const activities = declareActivitiesHandler({
      contract,
      activities: {
        sendEmail: () => OkAsync({ sent: true }),
        processOrder: {
          chargePayment: (_args, { errors }) =>
            ErrAsync(errors.PaymentDeclined({ reason: "insufficient_funds" })),
        },
      },
    });

    const rejection = activities.chargePayment({ amount: 100 });
    await expect(rejection).rejects.toBeInstanceOf(ApplicationFailure);
    await expect(rejection).rejects.toMatchObject({
      type: "PaymentDeclined",
      message: "The payment was declined",
      nonRetryable: true,
      details: [{ reason: "insufficient_funds" }],
    });
  });

  it("serializes data-less errors with empty details and contract retryability", async () => {
    const activities = declareActivitiesHandler({
      contract,
      activities: {
        sendEmail: () => OkAsync({ sent: true }),
        processOrder: {
          chargePayment: (_args, { errors }) => ErrAsync(errors.GatewayUnavailable()),
        },
      },
    });

    await expect(activities.chargePayment({ amount: 100 })).rejects.toMatchObject({
      type: "GatewayUnavailable",
      nonRetryable: false,
      details: [],
    });
  });

  it("transmits the ORIGINAL error data, not the parsed value (D1 wire format)", async () => {
    // The producer validates the payload (fail early) but `details[0]`
    // carries the original value — the consuming side (client / workflow
    // proxy rehydration) parses it against the declared schema exactly once.
    const transformingContract = defineContract({
      taskQueue: "test-queue",
      workflows: {
        noop: { input: z.object({}), output: z.object({}) },
      },
      activities: {
        flaky: {
          input: z.object({}),
          output: z.object({}),
          errors: {
            Nope: { data: z.object({ reason: z.string().transform((s) => `${s}!`) }) },
          },
        },
      },
    });
    const activities = declareActivitiesHandler({
      contract: transformingContract,
      activities: {
        flaky: (_args, { errors }) => ErrAsync(errors.Nope({ reason: "declined" })),
      },
    });

    await expect(activities.flaky({})).rejects.toMatchObject({
      type: "Nope",
      details: [{ reason: "declined" }], // not [{ reason: "declined!" }]
    });
  });

  it("fails fast when the error data does not validate against its schema", async () => {
    const activities = declareActivitiesHandler({
      contract,
      activities: {
        sendEmail: () => OkAsync({ sent: true }),
        processOrder: {
          chargePayment: (_args, { errors }) =>
            // @ts-expect-error — deliberately invalid payload
            ErrAsync(errors.PaymentDeclined({ reason: 42 })),
        },
      },
    });

    await expect(activities.chargePayment({ amount: 100 })).rejects.toBeInstanceOf(
      ContractErrorDataValidationError,
    );
  });

  it("fails fast on a ContractError whose name is not declared for the activity", async () => {
    const foreign = new ContractError({
      errorName: "NotDeclaredHere",
      data: undefined,
      message: "constructed outside the typed constructors",
    });
    const activities = declareActivitiesHandler({
      contract,
      activities: {
        sendEmail: () => OkAsync({ sent: true }),
        processOrder: {
          chargePayment: () => ErrAsync(foreign) as never,
        },
      },
    });

    const rejection = activities.chargePayment({ amount: 100 });
    await expect(rejection).rejects.toBeInstanceOf(ContractErrorDataValidationError);
    await expect(rejection).rejects.toMatchObject({
      message: expect.stringContaining('"NotDeclaredHere" is not declared'),
    });
  });

  it("keeps plain ApplicationFailure errors untouched", async () => {
    const failure = ApplicationFailure.create({ type: "GATEWAY_5XX", message: "boom" });
    const activities = declareActivitiesHandler({
      contract,
      activities: {
        sendEmail: () => OkAsync({ sent: true }),
        processOrder: {
          chargePayment: () => ErrAsync(failure),
        },
      },
    });

    await expect(activities.chargePayment({ amount: 100 })).rejects.toBe(failure);
  });
});

describe("declareActivitiesHandler — createContext", () => {
  it("passes the created context to implementations", async () => {
    const paymentGateway = { charge: vi.fn().mockResolvedValue("tx-1") };
    const activities = declareActivitiesHandler({
      contract,
      createContext: () => ({ paymentGateway }),
      activities: {
        sendEmail: () => OkAsync({ sent: true }),
        processOrder: {
          chargePayment: (args, { context }) =>
            OkAsync({
              transactionId: `${context.paymentGateway === paymentGateway}-${args.amount}`,
            }),
        },
      },
    });

    await expect(activities.chargePayment({ amount: 7 })).resolves.toEqual({
      transactionId: "true-7",
    });
  });

  it("invokes createContext per execution with the activity identity", async () => {
    const createContext = vi.fn().mockResolvedValue({});
    const activities = declareActivitiesHandler({
      contract,
      createContext,
      activities: {
        sendEmail: () => OkAsync({ sent: true }),
        processOrder: {
          chargePayment: () => OkAsync({ transactionId: "tx" }),
        },
      },
    });

    await activities.chargePayment({ amount: 1 });
    await activities.sendEmail({ to: "a@b.c" });

    expect(createContext).toHaveBeenNthCalledWith(1, {
      activityName: "chargePayment",
      workflowName: "processOrder",
    });
    expect(createContext).toHaveBeenNthCalledWith(2, {
      activityName: "sendEmail",
      workflowName: undefined,
    });
  });
});

describe("declareActivitiesHandler — middleware", () => {
  const passthroughImplementations = {
    sendEmail: () => OkAsync({ sent: true }),
    processOrder: {
      chargePayment: () => OkAsync({ transactionId: "tx" }),
    },
  };

  it("composes outermost-first and sees the validated input", async () => {
    const order: string[] = [];
    const seenInputs: unknown[] = [];
    const mw =
      (label: string): ActivityMiddleware =>
      (invocation, next) => {
        order.push(`${label}:${invocation.activityName}`);
        seenInputs.push(invocation.input);
        return next();
      };

    const activities = declareActivitiesHandler({
      contract,
      middleware: composeActivityMiddleware(mw("outer"), mw("inner")),
      activities: passthroughImplementations,
    });

    await activities.chargePayment({ amount: 3 });

    expect(order).toEqual(["outer:chargePayment", "inner:chargePayment"]);
    expect(seenInputs).toEqual([{ amount: 3 }, { amount: 3 }]);
  });

  it("does not run middleware when input validation fails", async () => {
    const middleware = vi.fn<ActivityMiddleware>((_invocation, next) => next());
    const activities = declareActivitiesHandler({
      contract,
      middleware,
      activities: passthroughImplementations,
    });

    // @ts-expect-error — deliberately invalid input
    await expect(activities.chargePayment({ amount: "nope" })).rejects.toThrow();
    expect(middleware).not.toHaveBeenCalled();
  });

  it("can substitute the input seen by the implementation", async () => {
    const activities = declareActivitiesHandler({
      contract,
      middleware: (_invocation, next) => next({ input: { amount: 999 } }),
      activities: {
        sendEmail: () => OkAsync({ sent: true }),
        processOrder: {
          chargePayment: (args) => OkAsync({ transactionId: `tx-${args.amount}` }),
        },
      },
    });

    await expect(activities.chargePayment({ amount: 1 })).resolves.toEqual({
      transactionId: "tx-999",
    });
  });

  it("re-validates a substituted input — an invalid substitution fails terminally", async () => {
    const implementation = vi.fn(() => OkAsync({ transactionId: "tx" }));
    const activities = declareActivitiesHandler({
      contract,
      middleware: (_invocation, next) => next({ input: { amount: "not-a-number" } }),
      activities: {
        sendEmail: () => OkAsync({ sent: true }),
        processOrder: { chargePayment: implementation },
      },
    });

    await expect(activities.chargePayment({ amount: 1 })).rejects.toMatchObject({
      type: "ActivityInputValidationError",
    });
    expect(implementation).not.toHaveBeenCalled();
  });

  it("can short-circuit with its own result — output still validated", async () => {
    const implementation = vi.fn(() => OkAsync({ transactionId: "tx" }));
    const activities = declareActivitiesHandler({
      contract,
      middleware: () => OkAsync({ transactionId: "cached" }),
      activities: {
        sendEmail: () => OkAsync({ sent: true }),
        processOrder: { chargePayment: implementation },
      },
    });

    await expect(activities.chargePayment({ amount: 1 })).resolves.toEqual({
      transactionId: "cached",
    });
    expect(implementation).not.toHaveBeenCalled();
  });

  it("observes typed errors on the err channel", async () => {
    const observed: unknown[] = [];
    const observing: ActivityMiddleware = (_invocation, next) =>
      next().tapErrCases((matcher) =>
        matcher.with(
          P.instanceOf(ApplicationFailure),
          P.tag("@temporal-contract/ContractError"),
          (error) => {
            observed.push(error);
          },
        ),
      );

    const activities = declareActivitiesHandler({
      contract,
      middleware: observing,
      activities: {
        sendEmail: () => OkAsync({ sent: true }),
        processOrder: {
          chargePayment: (_args, { errors }) =>
            ErrAsync(errors.PaymentDeclined({ reason: "expired_card" })),
        },
      },
    });

    await expect(activities.chargePayment({ amount: 1 })).rejects.toMatchObject({
      type: "PaymentDeclined",
    });
    expect(observed).toHaveLength(1);
    expect(observed[0]).toBeInstanceOf(ContractError);
  });

  it("receives the created context", async () => {
    const seen: unknown[] = [];
    const activities = declareActivitiesHandler({
      contract,
      createContext: () => ({ tenant: "acme" }),
      middleware: (invocation, next) => {
        seen.push(invocation.context);
        return next();
      },
      activities: passthroughImplementations,
    });

    await activities.sendEmail({ to: "a@b.c" });
    expect(seen).toEqual([{ tenant: "acme" }]);
  });

  it("accumulates context across the chain — seed, then per-middleware patches", async () => {
    const seenByInner: unknown[] = [];
    const seenByImplementation: unknown[] = [];

    const outer = declareActivityMiddleware<
      { tenant: string },
      { tenant: string; traceId: string }
    >((invocation, next) => next({ context: { ...invocation.context, traceId: "t-1" } }));
    const inner = declareActivityMiddleware<
      { tenant: string; traceId: string },
      { tenant: string; traceId: string; attempt: number }
    >((invocation, next) => {
      seenByInner.push(invocation.context);
      return next({ context: { ...invocation.context, attempt: 1 } });
    });

    const activities = declareActivitiesHandler({
      contract,
      createContext: () => ({ tenant: "acme" }),
      middleware: composeActivityMiddleware(outer, inner),
      activities: {
        sendEmail: (_args, { context }) => {
          seenByImplementation.push(context);
          return OkAsync({ sent: true });
        },
        processOrder: {
          chargePayment: () => OkAsync({ transactionId: "tx" }),
        },
      },
    });

    await activities.sendEmail({ to: "a@b.c" });

    // Inner middleware sees the seed + the outer patch...
    expect(seenByInner).toEqual([{ tenant: "acme", traceId: "t-1" }]);
    // ...and the implementation sees the full accumulation.
    expect(seenByImplementation).toEqual([{ tenant: "acme", traceId: "t-1", attempt: 1 }]);
  });

  it("read-only middleware stays valid unchanged and context defaults to an empty object", async () => {
    const seen: unknown[] = [];
    const activities = declareActivitiesHandler({
      contract,
      middleware: (invocation, next) => {
        seen.push(invocation.context);
        return next();
      },
      activities: passthroughImplementations,
    });

    await activities.sendEmail({ to: "a@b.c" });
    expect(seen).toEqual([{}]);
  });
});
