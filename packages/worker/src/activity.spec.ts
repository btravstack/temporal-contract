import type { ContractDefinition } from "@temporal-contract/contract";
import { Ok, Err, fromSafePromise, type AsyncResult } from "unthrown";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { ApplicationFailure, declareActivitiesHandler, qualifyFailure } from "./activity.js";
import {
  ActivityDefinitionNotFoundError,
  ActivityInputValidationError,
  ActivityOutputValidationError,
} from "./errors.js";

// unthrown has no `okAsync`/`errAsync`; lift a sync `Result` with `.toAsync()`.
const okAsync = <T>(value: T): AsyncResult<T, never> => Ok(value).toAsync();
const errAsync = <E>(error: E): AsyncResult<never, E> => Err(error).toAsync();

describe("Worker unthrown Package", () => {
  describe("declareActivitiesHandler", () => {
    it("should create an activities handler with Result pattern", () => {
      // GIVEN
      const contract = {
        taskQueue: "test-queue",
        workflows: {
          testWorkflow: {
            input: z.object({ value: z.string() }),
            output: z.object({ result: z.string() }),
          },
        },
        activities: {
          sendEmail: {
            input: z.object({ to: z.string(), subject: z.string(), body: z.string() }),
            output: z.object({ sent: z.boolean() }),
          },
        },
      } satisfies ContractDefinition;

      // WHEN — `testWorkflow` declares no activities, so no `testWorkflow: {}`
      // placeholder entry is needed (or accepted) in the implementations map.
      const activities = declareActivitiesHandler({
        contract,
        activities: {
          sendEmail: () => okAsync({ sent: true }),
        },
      });

      // THEN
      expect(activities).toEqual(
        expect.objectContaining({
          sendEmail: expect.any(Function),
        }),
      );
    });

    it("should validate activity input with Zod", async () => {
      // GIVEN
      const contract = {
        taskQueue: "test-queue",
        workflows: {},
        activities: {
          processPayment: {
            input: z.object({ amount: z.number(), currency: z.string() }),
            output: z.object({ transactionId: z.string() }),
          },
        },
      } satisfies ContractDefinition;

      const activities = declareActivitiesHandler({
        contract,
        activities: {
          processPayment: (args) => okAsync({ transactionId: `tx-${args.amount}` }),
        },
      });

      // WHEN - valid input
      const result = await activities.processPayment({ amount: 100, currency: "USD" });

      // THEN - valid input should work
      expect(result).toEqual(expect.objectContaining({ transactionId: "tx-100" }));

      // WHEN - invalid input
      // THEN - invalid input should throw
      await expect(
        // @ts-expect-error
        activities.processPayment({ amount: "invalid", currency: "USD" }),
      ).rejects.toThrow();
    });

    it("should validate activity output with Zod", async () => {
      // GIVEN
      const contract = {
        taskQueue: "test-queue",
        workflows: {},
        activities: {
          fetchData: {
            input: z.object({ id: z.string() }),
            output: z.object({ data: z.string(), timestamp: z.number() }),
          },
        },
      } satisfies ContractDefinition;

      const activities = declareActivitiesHandler({
        contract,
        activities: {
          fetchData: (args) => okAsync({ data: `data-${args.id}`, timestamp: 123 }),
        },
      });

      // WHEN
      const result = await activities.fetchData({ id: "abc" });

      // THEN
      expect(result).toEqual(expect.objectContaining({ data: "data-abc", timestamp: 123 }));

      // WHEN - bad activities producing invalid output
      const badActivities = declareActivitiesHandler({
        contract,
        activities: {
          fetchData: (
            _args,
          ): AsyncResult<{ data: string; timestamp: number }, ApplicationFailure> =>
            // @ts-expect-error - intentionally returning invalid output
            okAsync({ data: "test" }), // Missing timestamp
        },
      });

      // THEN - invalid output should throw
      await expect(badActivities["fetchData"]({ id: "abc" })).rejects.toThrow();
    });

    it("should handle Ok() by returning value", async () => {
      // GIVEN
      const contract = {
        taskQueue: "test-queue",
        workflows: {},
        activities: {
          successActivity: {
            input: z.object({ value: z.string() }),
            output: z.object({ result: z.string() }),
          },
        },
      } satisfies ContractDefinition;

      const activities = declareActivitiesHandler({
        contract,
        activities: {
          successActivity: (args) => okAsync({ result: `success-${args.value}` }),
        },
      });

      // WHEN
      const result = await activities.successActivity({ value: "test" });

      // THEN
      expect(result).toEqual(expect.objectContaining({ result: "success-test" }));
    });

    it("should handle Err() by throwing exception", async () => {
      // GIVEN
      const contract = {
        taskQueue: "test-queue",
        workflows: {},
        activities: {
          failingActivity: {
            input: z.object({ value: z.string() }),
            output: z.object({ result: z.string() }),
          },
        },
      } satisfies ContractDefinition;

      const activities = declareActivitiesHandler({
        contract,
        activities: {
          failingActivity: (_args) =>
            errAsync(
              ApplicationFailure.create({
                type: "ACTIVITY_FAILED",
                message: "Something went wrong",
                details: [{ info: "additional details" }],
              }),
            ),
        },
      });

      // WHEN / THEN - should throw the ApplicationFailure unchanged so
      // Temporal recognizes the type/message/details when serializing.
      const rejected = await activities.failingActivity({ value: "test" }).then(
        () => {
          throw new Error("expected rejection");
        },
        (err: unknown) => err,
      );
      expect(rejected).toBeInstanceOf(ApplicationFailure);
      expect((rejected as ApplicationFailure).type).toBe("ACTIVITY_FAILED");
      expect((rejected as ApplicationFailure).message).toBe("Something went wrong");
      expect((rejected as ApplicationFailure).details).toEqual([{ info: "additional details" }]);
    });

    it("preserves `nonRetryable: true` when unwrapping Err() and rethrowing the ApplicationFailure", async () => {
      const contract = {
        taskQueue: "test-queue",
        workflows: {},
        activities: {
          permanentlyFailingActivity: {
            input: z.object({}),
            output: z.object({}),
          },
        },
      } satisfies ContractDefinition;

      const activities = declareActivitiesHandler({
        contract,
        activities: {
          permanentlyFailingActivity: (_args) =>
            errAsync(
              ApplicationFailure.create({
                type: "PERMANENT",
                message: "do not retry",
                nonRetryable: true,
              }),
            ),
        },
      });

      const rejected = await activities.permanentlyFailingActivity({}).then(
        () => {
          throw new Error("expected rejection");
        },
        (err: unknown) => err,
      );
      expect(rejected).toBeInstanceOf(ApplicationFailure);
      expect((rejected as ApplicationFailure).nonRetryable).toBe(true);
    });

    it("should handle async work properly", async () => {
      // GIVEN
      const contract = {
        taskQueue: "test-queue",
        workflows: {},
        activities: {
          asyncActivity: {
            input: z.object({ delay: z.number() }),
            output: z.object({ completed: z.boolean() }),
          },
        },
      } satisfies ContractDefinition;

      const activities = declareActivitiesHandler({
        contract,
        activities: {
          asyncActivity: (args) =>
            fromSafePromise<{ completed: boolean }>(
              new Promise((resolve) => {
                setTimeout(() => resolve({ completed: true }), args.delay);
              }),
            ),
        },
      });

      // WHEN
      const result = await activities.asyncActivity({ delay: 10 });

      // THEN
      expect(result).toEqual(expect.objectContaining({ completed: true }));
    });

    it("should support workflow-specific activities", async () => {
      // GIVEN
      const contract = {
        taskQueue: "test-queue",
        workflows: {
          orderWorkflow: {
            input: z.object({ orderId: z.string() }),
            output: z.object({ status: z.string() }),
            activities: {
              validateOrder: {
                input: z.object({ orderId: z.string() }),
                output: z.object({ valid: z.boolean() }),
              },
            },
          },
        },
      } satisfies ContractDefinition;

      const activities = declareActivitiesHandler({
        contract,
        activities: {
          orderWorkflow: {
            validateOrder: (args) => okAsync({ valid: args.orderId.length > 0 }),
          },
        },
      });

      // WHEN
      const result = await activities.validateOrder({ orderId: "123" });

      // THEN
      expect(result).toEqual(expect.objectContaining({ valid: true }));
    });

    it("should throw if activity definition is not found", () => {
      // GIVEN
      const contract = {
        taskQueue: "test-queue",
        workflows: {},
        activities: {
          validActivity: {
            input: z.object({ value: z.string() }),
            output: z.object({ result: z.string() }),
          },
        },
      } satisfies ContractDefinition;

      // WHEN / THEN
      expect(() => {
        declareActivitiesHandler({
          contract,
          activities: {
            validActivity: (_args: unknown) => okAsync({ result: "test" }),
            // @ts-expect-error - intentionally missing activity definition
            unknownActivity: (_args: unknown) => okAsync({ result: "test" }),
          },
        });
      }).toThrowError(new ActivityDefinitionNotFoundError("unknownActivity", ["validActivity"]));
    });

    it("rejects stray root-level keys even when the contract has no global activities", () => {
      // Previously the stray-key check only ran when `contract.activities`
      // existed — an unknown root key on an activity-less contract was
      // silently ignored.
      const contract = {
        taskQueue: "test-queue",
        workflows: {
          noopWorkflow: {
            input: z.object({}),
            output: z.object({}),
          },
        },
      } satisfies ContractDefinition;

      expect(() => {
        declareActivitiesHandler({
          contract,
          // The implementations type collapses to `{}` here (no globals, no
          // workflow activities), which TypeScript can't flag excess keys
          // against — the runtime check is the only guard.
          activities: {
            strayActivity: (_args: unknown) => okAsync({}),
          },
        });
      }).toThrowError(new ActivityDefinitionNotFoundError("strayActivity", []));
    });

    it("fails fast when a declared global activity has no implementation", () => {
      const contract = {
        taskQueue: "test-queue",
        workflows: {},
        activities: {
          implemented: {
            input: z.object({}),
            output: z.object({}),
          },
          forgotten: {
            input: z.object({}),
            output: z.object({}),
          },
        },
      } satisfies ContractDefinition;

      expect(() => {
        declareActivitiesHandler({
          contract,
          // @ts-expect-error - intentionally omitting a declared implementation
          activities: {
            implemented: (_args: unknown) => okAsync({}),
          },
        });
      }).toThrow(/missing implementation for declared activity: forgotten/);
    });

    it("fails fast when a declared workflow-local activity has no implementation", () => {
      const contract = {
        taskQueue: "test-queue",
        workflows: {
          orderWorkflow: {
            input: z.object({}),
            output: z.object({}),
            activities: {
              validateOrder: {
                input: z.object({}),
                output: z.object({}),
              },
              shipOrder: {
                input: z.object({}),
                output: z.object({}),
              },
            },
          },
        },
      } satisfies ContractDefinition;

      // Namespace present but incomplete — the missing key is reported with
      // its owning workflow.
      expect(() => {
        declareActivitiesHandler({
          contract,
          activities: {
            // @ts-expect-error - intentionally omitting a declared implementation
            orderWorkflow: {
              validateOrder: (_args: unknown) => okAsync({}),
            },
          },
        });
      }).toThrow(/missing implementation for declared activity: orderWorkflow\.shipOrder/);

      // Namespace absent entirely — every declared activity is reported.
      expect(() => {
        declareActivitiesHandler({
          contract,
          // @ts-expect-error - intentionally omitting the whole namespace
          activities: {},
        });
      }).toThrow(
        /missing implementations for declared activities: orderWorkflow\.validateOrder, orderWorkflow\.shipOrder/,
      );
    });

    it("throws on a workflow-name/global-activity-name collision (defense-in-depth)", () => {
      // `defineContract` rejects this shape too; the handler re-checks for
      // contracts built as raw literals that never went through it.
      const contract = {
        taskQueue: "test-queue",
        workflows: {
          conflicted: {
            input: z.object({}),
            output: z.object({}),
          },
        },
        activities: {
          conflicted: {
            input: z.object({}),
            output: z.object({}),
          },
        },
      } satisfies ContractDefinition;

      expect(() => {
        declareActivitiesHandler({
          contract,
          activities: {
            conflicted: (_args: unknown) => okAsync({}),
          },
        });
      }).toThrow(/global activity "conflicted" has the same name as a workflow/);
    });
  });

  describe("wire format (validate on send, parse on receive)", () => {
    // D1: the activity handler is the RECEIVING side of the input boundary —
    // it parses the payload exactly once, so the implementation sees the
    // transformed value. For the output it is the SENDING side: the return
    // value is validated (fail early) but Temporal gets the implementation's
    // ORIGINAL value; the workflow-side proxy parses it on receive.
    const transformContract = {
      taskQueue: "test-queue",
      workflows: {},
      activities: {
        transformer: {
          input: z.object({ text: z.string().transform((s) => `${s}!`) }),
          output: z.object({ n: z.number().transform((n) => n * 2) }),
        },
      },
    } satisfies ContractDefinition;

    it("the implementation receives the PARSED input (transform applied once)", async () => {
      const seen: unknown[] = [];
      const activities = declareActivitiesHandler({
        contract: transformContract,
        activities: {
          transformer: (args) => {
            seen.push(args);
            return okAsync({ n: 21 });
          },
        },
      });

      await activities.transformer({ text: "hi" });

      expect(seen).toEqual([{ text: "hi!" }]);
    });

    it("Temporal gets the implementation's ORIGINAL output, not the parsed value", async () => {
      const activities = declareActivitiesHandler({
        contract: transformContract,
        activities: {
          transformer: () => okAsync({ n: 21 }),
        },
      });

      const result = await activities.transformer({ text: "hi" });

      // Validated against the output schema, but transmitted untransformed —
      // the receiving side (workflow proxy / raw caller) parses it.
      expect(result).toEqual({ n: 21 });
    });
  });

  describe("Error Handling", () => {
    it("should throw ActivityInputValidationError for invalid input", async () => {
      // GIVEN
      const contract = {
        taskQueue: "test-queue",
        workflows: {},
        activities: {
          strictActivity: {
            input: z.object({ amount: z.number().positive(), email: z.string().email() }),
            output: z.object({ success: z.boolean() }),
          },
        },
      } satisfies ContractDefinition;

      const activities = declareActivitiesHandler({
        contract,
        activities: {
          strictActivity: (_args) => okAsync({ success: true }),
        },
      });

      // WHEN / THEN
      const error = await activities.strictActivity({ amount: -10, email: "invalid" }).then(
        () => {
          throw new Error("expected rejection");
        },
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(ActivityInputValidationError);
      expect(error).toMatchObject({
        activityName: "strictActivity",
        message: expect.stringContaining("strictActivity"),
      });
    });

    it("should throw ActivityOutputValidationError for invalid output", async () => {
      // GIVEN
      const contract = {
        taskQueue: "test-queue",
        workflows: {},
        activities: {
          strictOutputActivity: {
            input: z.object({ id: z.string() }),
            output: z.object({ value: z.number(), status: z.enum(["active", "inactive"]) }),
          },
        },
      } satisfies ContractDefinition;

      const activities = declareActivitiesHandler({
        contract,
        activities: {
          // @ts-expect-error - intentionally returning invalid output
          strictOutputActivity: (_args) => okAsync({ value: "not-a-number", status: "active" }),
        },
      });

      // WHEN / THEN
      const error = await activities.strictOutputActivity({ id: "123" }).then(
        () => {
          throw new Error("expected rejection");
        },
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(ActivityOutputValidationError);
      expect(error).toMatchObject({
        activityName: "strictOutputActivity",
        message: expect.stringContaining("strictOutputActivity"),
      });
    });
  });

  describe("qualifyFailure", () => {
    it("wraps an Error rejection in an ApplicationFailure with the given type", () => {
      // GIVEN
      const cause = new Error("connection refused");

      // WHEN
      const failure = qualifyFailure("EMAIL_SEND_FAILED")(cause);

      // THEN
      expect(failure).toBeInstanceOf(ApplicationFailure);
      expect(failure.type).toBe("EMAIL_SEND_FAILED");
      expect(failure.message).toBe("connection refused");
      expect(failure.cause).toBe(cause);
      expect(failure.nonRetryable).toBeFalsy();
    });

    it("uses the fallback message for a non-Error rejection", () => {
      // WHEN
      const failure = qualifyFailure("PAYMENT_FAILED", { message: "Failed to charge card" })(
        "boom",
      );

      // THEN
      expect(failure.type).toBe("PAYMENT_FAILED");
      expect(failure.message).toBe("Failed to charge card");
      expect(failure.cause).toBeUndefined();
    });

    it("stringifies a non-Error rejection when no fallback message is given", () => {
      // WHEN
      const failure = qualifyFailure("PAYMENT_FAILED")({ code: 42 });

      // THEN
      expect(failure.message).toBe("[object Object]");
      expect(failure.cause).toBeUndefined();
    });

    it("prefers the rejection's own message over the fallback for Error rejections", () => {
      // WHEN
      const failure = qualifyFailure("PAYMENT_FAILED", { message: "fallback" })(
        new Error("declined"),
      );

      // THEN
      expect(failure.message).toBe("declined");
    });

    it("forwards nonRetryable and details to the failure", () => {
      // WHEN
      const failure = qualifyFailure("INSUFFICIENT_FUNDS", {
        nonRetryable: true,
        details: [{ balance: 0 }],
      })(new Error("declined"));

      // THEN
      expect(failure.nonRetryable).toBe(true);
      expect(failure.details).toEqual([{ balance: 0 }]);
    });

    it("always wraps — even an ApplicationFailure rejection — so the declared type is guaranteed", () => {
      // GIVEN
      const inner = ApplicationFailure.create({ type: "INNER", message: "already modeled" });

      // WHEN
      const failure = qualifyFailure("OUTER")(inner);

      // THEN — callers can rely on `type` for retry policies; the original
      // failure is preserved as `cause`.
      expect(failure.type).toBe("OUTER");
      expect(failure.message).toBe("already modeled");
      expect(failure.cause).toBe(inner);
    });
  });
});
