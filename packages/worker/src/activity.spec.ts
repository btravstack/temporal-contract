import { describe, expect, it } from "vitest";
import { Future, Result } from "@swan-io/boxed";
import { z } from "zod";
import { ApplicationFailure } from "@temporalio/common";
import { ActivityDefinitionNotFoundError } from "./errors.js";
import type { ContractDefinition } from "@temporal-contract/contract";
import { ActivityError, declareActivitiesHandler } from "./activity.js";

describe("Worker-Boxed Package", () => {
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
          sendEmail: () => {
            return Future.value(Result.Ok({ sent: true }));
          },
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
          processPayment: (args) => {
            return Future.value(Result.Ok({ transactionId: `tx-${args.amount}` }));
          },
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
          fetchData: (args) => {
            return Future.value(Result.Ok({ data: `data-${args.id}`, timestamp: 123 }));
          },
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
          ): Future<Result<{ data: string; timestamp: number }, ActivityError>> => {
            // @ts-expect-error - intentionally returning invalid output
            return Future.value(Result.Ok({ data: "test" })); // Missing timestamp
          },
        },
      });

      // THEN - invalid output should throw
      await expect(badActivities["fetchData"]({ id: "abc" })).rejects.toThrow();
    });

    it("should handle Result.Ok by returning value", async () => {
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
          successActivity: (args) => {
            return Future.value(Result.Ok({ result: `success-${args.value}` }));
          },
        },
      });

      // WHEN
      const result = await activities.successActivity({ value: "test" });

      // THEN
      expect(result).toEqual(expect.objectContaining({ result: "success-test" }));
    });

    it("should handle Result.Error by throwing exception", async () => {
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

      const cause = new Error("upstream gateway error");

      const activities = declareActivitiesHandler({
        contract,
        activities: {
          failingActivity: (_args) => {
            return Future.value(
              Result.Error(new ActivityError("ACTIVITY_FAILED", "Something went wrong", { cause })),
            );
          },
        },
      });

      // WHEN / THEN — wrapper rethrows as ApplicationFailure carrying the
      // ActivityError's code as `type` and the cause as `cause`.
      await expect(activities.failingActivity({ value: "test" })).rejects.toEqual(
        expect.objectContaining({
          name: "ApplicationFailure",
          message: "Something went wrong",
          type: "ACTIVITY_FAILED",
          nonRetryable: false,
          cause,
        }),
      );
    });

    it("should handle Future properly", async () => {
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
          asyncActivity: (args) => {
            return Future.make<Result<{ completed: boolean }, ActivityError>>((resolve) => {
              setTimeout(() => {
                resolve(Result.Ok({ completed: true }));
              }, args.delay);
            });
          },
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
            validateOrder: (args) => {
              return Future.value(Result.Ok({ valid: args.orderId.length > 0 }));
            },
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
            validActivity: (_args: unknown) => Future.value(Result.Ok({ result: "test" })),
            // @ts-expect-error - intentionally missing activity definition
            unknownActivity: (_args: unknown) => Future.value(Result.Ok({ result: "test" })),
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
          strictActivity: (_args) => {
            return Future.value(Result.Ok({ success: true }));
          },
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
          strictOutputActivity: (_args) => {
            return Future.value(Result.Ok({ value: "not-a-number", status: "active" }));
          },
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

    describe("ActivityError → ApplicationFailure conversion", () => {
      // Closes #121 — `ActivityError` now carries Temporal retry-policy
      // metadata. The wrapper translates it into an `ApplicationFailure` so
      // Temporal honors the directives at the SDK boundary.

      const contract = {
        taskQueue: "test-queue",
        workflows: {},
        activities: {
          run: {
            input: z.object({}),
            output: z.object({}),
          },
        },
      } satisfies ContractDefinition;

      it("propagates nonRetryable=true through to the thrown ApplicationFailure", async () => {
        const activities = declareActivitiesHandler({
          contract,
          activities: {
            run: () =>
              Future.value(
                Result.Error(
                  new ActivityError("PAYMENT_DECLINED", "Card was declined", {
                    nonRetryable: true,
                  }),
                ),
              ),
          },
        });

        await expect(activities.run({})).rejects.toEqual(
          expect.objectContaining({
            name: "ApplicationFailure",
            type: "PAYMENT_DECLINED",
            nonRetryable: true,
          }),
        );
      });

      it("defaults nonRetryable to false when not specified", async () => {
        const activities = declareActivitiesHandler({
          contract,
          activities: {
            run: () =>
              Future.value(Result.Error(new ActivityError("TRANSIENT", "Try again later"))),
          },
        });

        await expect(activities.run({})).rejects.toMatchObject({
          name: "ApplicationFailure",
          type: "TRANSIENT",
          nonRetryable: false,
        });
      });

      it("forwards details and nextRetryDelay onto the ApplicationFailure", async () => {
        const activities = declareActivitiesHandler({
          contract,
          activities: {
            run: () =>
              Future.value(
                Result.Error(
                  new ActivityError("RATE_LIMITED", "Throttled", {
                    details: [{ retryAfterSeconds: 30 }, "x-trace-123"],
                    nextRetryDelay: "30 seconds",
                  }),
                ),
              ),
          },
        });

        await expect(activities.run({})).rejects.toMatchObject({
          name: "ApplicationFailure",
          type: "RATE_LIMITED",
          details: [{ retryAfterSeconds: 30 }, "x-trace-123"],
          nextRetryDelay: "30 seconds",
        });
      });

      it("attaches an Error cause to the thrown ApplicationFailure", async () => {
        const cause = new Error("network down");

        const activities = declareActivitiesHandler({
          contract,
          activities: {
            run: () =>
              Future.value(
                Result.Error(new ActivityError("UPSTREAM", "Upstream failed", { cause })),
              ),
          },
        });

        await expect(activities.run({})).rejects.toMatchObject({
          name: "ApplicationFailure",
          cause,
        });
      });

      it("does not forward a non-Error cause onto the thrown ApplicationFailure", async () => {
        // Plain-object causes are stored on `ActivityError.cause` for reference,
        // but ApplicationFailure's `cause` slot only accepts an `Error`, so the
        // wrapper drops non-Error causes rather than forwarding them.
        const activities = declareActivitiesHandler({
          contract,
          activities: {
            run: () =>
              Future.value(
                Result.Error(
                  new ActivityError("UPSTREAM", "Upstream failed", {
                    cause: { kind: "plain-object", reason: "n/a" },
                  }),
                ),
              ),
          },
        });

        const failure = await activities.run({}).catch((err: unknown) => err);
        expect(failure).toEqual(
          expect.objectContaining({
            name: "ApplicationFailure",
            type: "UPSTREAM",
          }),
        );
        expect((failure as { cause?: unknown }).cause).toBeUndefined();
      });

      it("preserves the original ActivityError stack on the thrown ApplicationFailure", async () => {
        // The ActivityError stack points at the activity-implementation site;
        // without preservation, the ApplicationFailure stack would point into
        // the wrapper code in this package, hurting debuggability.
        const activityError = new ActivityError("STACK_CHECK", "preserve me");
        const expectedStack = activityError.stack;

        const activities = declareActivitiesHandler({
          contract,
          activities: {
            run: () => Future.value(Result.Error(activityError)),
          },
        });

        const failure = (await activities.run({}).catch((err: unknown) => err)) as Error;
        expect(failure.stack).toBe(expectedStack);
      });
    });

    describe("ApplicationFailure direct return", () => {
      // The error variant of Result accepts ApplicationFailure as well, so
      // consumers who already use Temporal's standard error class don't have
      // to wrap it.

      it("forwards a returned ApplicationFailure unchanged", async () => {
        const contract = {
          taskQueue: "test-queue",
          workflows: {},
          activities: {
            run: {
              input: z.object({}),
              output: z.object({}),
            },
          },
        } satisfies ContractDefinition;

        const activities = declareActivitiesHandler({
          contract,
          activities: {
            run: () =>
              Future.value(
                Result.Error(
                  ApplicationFailure.nonRetryable("permission denied", "PERMISSION_DENIED"),
                ),
              ),
          },
        });

        await expect(activities.run({})).rejects.toEqual(
          expect.objectContaining({
            name: "ApplicationFailure",
            type: "PERMISSION_DENIED",
            nonRetryable: true,
            message: "permission denied",
          }),
        );
      });
    });
  });
});
