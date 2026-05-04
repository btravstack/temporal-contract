import { describe, expect, it } from "vitest";
import { ResultAsync, okAsync, errAsync } from "neverthrow";
import { z } from "zod";
import { ActivityDefinitionNotFoundError } from "./errors.js";
import type { ContractDefinition } from "@temporal-contract/contract";
import { ApplicationFailure, declareActivitiesHandler } from "./activity.js";

describe("Worker neverthrow Package", () => {
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

      // WHEN
      const activities = declareActivitiesHandler({
        contract,
        activities: {
          testWorkflow: {},
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
          ): ResultAsync<{ data: string; timestamp: number }, ApplicationFailure> =>
            // @ts-expect-error - intentionally returning invalid output
            okAsync({ data: "test" }), // Missing timestamp
        },
      });

      // THEN - invalid output should throw
      await expect(badActivities["fetchData"]({ id: "abc" })).rejects.toThrow();
    });

    it("should handle ok() by returning value", async () => {
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

    it("should handle err() by throwing exception", async () => {
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

    it("preserves `nonRetryable: true` when unwrapping err() and rethrowing the ApplicationFailure", async () => {
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
            ResultAsync.fromSafePromise<{ completed: boolean }, ApplicationFailure>(
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
      await expect(activities.strictActivity({ amount: -10, email: "invalid" })).rejects.toEqual(
        expect.objectContaining({
          name: "ActivityInputValidationError",
          activityName: "strictActivity",
          message: expect.stringContaining("strictActivity"),
        }),
      );
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
      await expect(activities.strictOutputActivity({ id: "123" })).rejects.toEqual(
        expect.objectContaining({
          name: "ActivityOutputValidationError",
          activityName: "strictOutputActivity",
          message: expect.stringContaining("strictOutputActivity"),
        }),
      );
    });
  });
});
