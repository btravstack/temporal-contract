import type { ContractDefinition } from "@temporal-contract/contract";
import { OkAsync, ErrAsync, fromSafePromise, type AsyncResult } from "unthrown";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { ApplicationFailure, declareActivitiesHandler, qualifyFailure } from "./activity.js";
import {
  ActivityDefinitionNotFoundError,
  ActivityInputValidationError,
  ActivityOutputValidationError,
} from "./errors.js";

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
            idempotency: "allow-duplicate",
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
          sendEmail: () => OkAsync({ sent: true }),
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
          processPayment: (_, args) => OkAsync({ transactionId: `tx-${args.amount}` }),
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
          fetchData: (_, args) => OkAsync({ data: `data-${args.id}`, timestamp: 123 }),
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
          fetchData: (): AsyncResult<{ data: string; timestamp: number }, ApplicationFailure> =>
            // @ts-expect-error - intentionally returning invalid output
            OkAsync({ data: "test" }), // Missing timestamp
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
          successActivity: (_, args) => OkAsync({ result: `success-${args.value}` }),
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
          failingActivity: () =>
            ErrAsync(
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
          permanentlyFailingActivity: () =>
            ErrAsync(
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
          asyncActivity: (_, args) =>
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
            idempotency: "allow-duplicate",
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
            validateOrder: (_, args) => OkAsync({ valid: args.orderId.length > 0 }),
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
            validActivity: () => OkAsync({ result: "test" }),
            // @ts-expect-error - intentionally missing activity definition
            unknownActivity: () => OkAsync({ result: "test" }),
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
            idempotency: "allow-duplicate",
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
            strayActivity: () => OkAsync({}),
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
            implemented: () => OkAsync({}),
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
            idempotency: "allow-duplicate",
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
              validateOrder: () => OkAsync({}),
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

    describe("shared activity definitions (flat-namespace duplicate handling)", () => {
      // `defineContract` permits one `defineActivity` object to be referenced
      // from several scopes — it's ONE activity in Temporal's flat runtime
      // namespace. The handler must not let one scope's implementation
      // silently clobber another's (last-wins), and must dedupe when both
      // scopes supply the exact same function reference.
      const sharedDef = {
        input: z.object({ id: z.string() }),
        output: z.object({ ok: z.boolean() }),
      };
      const sharedContract = {
        taskQueue: "test-queue",
        workflows: {
          alpha: {
            input: z.object({}),
            output: z.object({}),
            idempotency: "allow-duplicate",
            activities: { sharedActivity: sharedDef },
          },
          beta: {
            input: z.object({}),
            output: z.object({}),
            idempotency: "allow-duplicate",
            activities: { sharedActivity: sharedDef },
          },
        },
      } satisfies ContractDefinition;

      it("throws at declaration time when two scopes supply different implementations", () => {
        expect(() => {
          declareActivitiesHandler({
            contract: sharedContract,
            activities: {
              alpha: { sharedActivity: () => OkAsync({ ok: true }) },
              beta: { sharedActivity: () => OkAsync({ ok: false }) },
            },
          });
        }).toThrow(
          /activity "sharedActivity" received two different implementations — one from workflow "alpha" and one from workflow "beta"/,
        );
      });

      it("the conflict message explains both resolutions (hoist to global, or share the function)", () => {
        expect(() => {
          declareActivitiesHandler({
            contract: sharedContract,
            activities: {
              alpha: { sharedActivity: () => OkAsync({ ok: true }) },
              beta: { sharedActivity: () => OkAsync({ ok: false }) },
            },
          });
        }).toThrow(
          /hoist the shared activity to the contract's global `activities` block|same implementation function reference/,
        );
      });

      it("dedupes silently when both scopes pass the exact same function reference", async () => {
        const calls: unknown[] = [];
        const shared = (_: unknown, args: { id: string }) => {
          calls.push(args);
          return OkAsync({ ok: true });
        };

        const activities = declareActivitiesHandler({
          contract: sharedContract,
          activities: {
            alpha: { sharedActivity: shared },
            beta: { sharedActivity: shared },
          },
        });

        // Exactly one flat registration, and it works.
        expect(Object.keys(activities)).toEqual(["sharedActivity"]);
        const result = await activities.sharedActivity({ id: "x" });
        expect(result).toEqual({ ok: true });
        expect(calls).toEqual([{ id: "x" }]);
      });

      it("conflicts between the global scope and a workflow scope are reported with both scope names", () => {
        const globalSharedContract = {
          taskQueue: "test-queue",
          workflows: {
            alpha: {
              input: z.object({}),
              output: z.object({}),
              idempotency: "allow-duplicate",
              activities: { sharedActivity: sharedDef },
            },
          },
          activities: { sharedActivity: sharedDef },
        } satisfies ContractDefinition;

        expect(() => {
          declareActivitiesHandler({
            contract: globalSharedContract,
            activities: {
              sharedActivity: () => OkAsync({ ok: true }),
              alpha: { sharedActivity: () => OkAsync({ ok: false }) },
            },
          });
        }).toThrow(
          /activity "sharedActivity" received two different implementations — one from the global scope and one from workflow "alpha"/,
        );
      });
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
            idempotency: "allow-duplicate",
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
            conflicted: () => OkAsync({}),
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
          transformer: (_, args) => {
            seen.push(args);
            return OkAsync({ n: 21 });
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
          transformer: () => OkAsync({ n: 21 }),
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
          strictActivity: () => OkAsync({ success: true }),
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
          strictOutputActivity: () => OkAsync({ value: "not-a-number", status: "active" }),
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
    // Stand-in for unthrown's injected `defect` helper: the tests only need
    // to observe that the qualifier routed the cause to the defect channel.
    const defectMarker = (cause: unknown) => ({ __defect: cause });
    class GatewayError extends Error {}
    class OtherGatewayError extends Error {}

    it("wraps a rejection matching an expected error class in an ApplicationFailure of the given type", () => {
      // GIVEN
      const cause = new GatewayError("connection refused");

      // WHEN
      const outcome = qualifyFailure("EMAIL_SEND_FAILED", { expected: GatewayError })(
        cause,
        defectMarker,
      );

      // THEN
      expect(outcome).toBeInstanceOf(ApplicationFailure);
      const failure = outcome as ApplicationFailure;
      expect(failure.type).toBe("EMAIL_SEND_FAILED");
      expect(failure.message).toBe("connection refused");
      expect(failure.cause).toBe(cause);
      expect(failure.nonRetryable).toBeFalsy();
    });

    it("routes an unexpected cause (e.g. a TypeError from a bug) to the defect channel", () => {
      // GIVEN — a TypeError is not in the modeled failure set.
      const bug = new TypeError("undefined is not a function");

      // WHEN
      const outcome = qualifyFailure("EMAIL_SEND_FAILED", { expected: GatewayError })(
        bug,
        defectMarker,
      );

      // THEN — the qualifier returned the injected defect, cause untouched.
      expect(outcome).toEqual({ __defect: bug });
    });

    it("accepts an array of expected classes (any match wraps)", () => {
      const qualify = qualifyFailure("GATEWAY_FAILED", {
        expected: [GatewayError, OtherGatewayError],
      });

      expect(qualify(new OtherGatewayError("down"), defectMarker)).toBeInstanceOf(
        ApplicationFailure,
      );
      expect(qualify(new RangeError("nope"), defectMarker)).toEqual({
        __defect: expect.any(RangeError),
      });
    });

    it("accepts a predicate for non-class causes", () => {
      const qualify = qualifyFailure("PAYMENT_FAILED", {
        expected: (cause) => typeof cause === "object" && cause !== null && "code" in cause,
        message: "Failed to charge card",
      });

      const wrapped = qualify({ code: 42 }, defectMarker);
      expect(wrapped).toBeInstanceOf(ApplicationFailure);
      expect((wrapped as ApplicationFailure).message).toBe("Failed to charge card");
      expect((wrapped as ApplicationFailure).cause).toBeUndefined();

      expect(qualify("boom", defectMarker)).toEqual({ __defect: "boom" });
    });

    it("expected: 'any' wraps every rejection (the explicit escape hatch)", () => {
      const qualify = qualifyFailure("PAYMENT_FAILED", { expected: "any" });

      const fromError = qualify(new TypeError("bug"), defectMarker);
      expect(fromError).toBeInstanceOf(ApplicationFailure);
      expect((fromError as ApplicationFailure).message).toBe("bug");

      const fromValue = qualify({ code: 42 }, defectMarker);
      expect(fromValue).toBeInstanceOf(ApplicationFailure);
      // No fallback message given — non-Error causes stringify.
      expect((fromValue as ApplicationFailure).message).toBe("[object Object]");
    });

    it("prefers the rejection's own message over the fallback for Error rejections", () => {
      const outcome = qualifyFailure("PAYMENT_FAILED", { expected: Error, message: "fallback" })(
        new Error("declined"),
        defectMarker,
      );

      expect((outcome as ApplicationFailure).message).toBe("declined");
    });

    it("forwards nonRetryable and details to the failure", () => {
      const outcome = qualifyFailure("INSUFFICIENT_FUNDS", {
        expected: Error,
        nonRetryable: true,
        details: [{ balance: 0 }],
      })(new Error("declined"), defectMarker);

      const failure = outcome as ApplicationFailure;
      expect(failure.nonRetryable).toBe(true);
      expect(failure.details).toEqual([{ balance: 0 }]);
    });

    it("always wraps a matched ApplicationFailure so the declared type is guaranteed", () => {
      // GIVEN
      const inner = ApplicationFailure.create({ type: "INNER", message: "already modeled" });

      // WHEN
      const outcome = qualifyFailure("OUTER", { expected: ApplicationFailure })(
        inner,
        defectMarker,
      );

      // THEN — callers can rely on `type` for retry policies; the original
      // failure is preserved as `cause`.
      const failure = outcome as ApplicationFailure;
      expect(failure.type).toBe("OUTER");
      expect(failure.message).toBe("already modeled");
      expect(failure.cause).toBe(inner);
    });

    it("inherits nonRetryable: true from a matched non-retryable ApplicationFailure by default", () => {
      // GIVEN — an inner permanent failure. Pre-v8, re-typing it silently
      // made it retryable again; now the wrapper inherits non-retryability.
      const inner = ApplicationFailure.create({
        type: "INNER",
        message: "permanent",
        nonRetryable: true,
      });

      // WHEN — no explicit `nonRetryable` option.
      const outcome = qualifyFailure("OUTER", { expected: ApplicationFailure })(
        inner,
        defectMarker,
      );

      // THEN
      expect((outcome as ApplicationFailure).nonRetryable).toBe(true);
    });

    it("an explicit nonRetryable option overrides the inherited value", () => {
      const inner = ApplicationFailure.create({
        type: "INNER",
        message: "permanent",
        nonRetryable: true,
      });

      const outcome = qualifyFailure("OUTER", {
        expected: ApplicationFailure,
        nonRetryable: false,
      })(inner, defectMarker);

      expect((outcome as ApplicationFailure).nonRetryable).toBe(false);
    });

    it("a matched retryable ApplicationFailure stays retryable", () => {
      const inner = ApplicationFailure.create({ type: "INNER", message: "transient" });

      const outcome = qualifyFailure("OUTER", { expected: ApplicationFailure })(
        inner,
        defectMarker,
      );

      expect((outcome as ApplicationFailure).nonRetryable).toBeFalsy();
    });
  });
});
