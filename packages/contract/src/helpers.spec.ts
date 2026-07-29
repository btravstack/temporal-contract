import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  defineActivity,
  defineQuery,
  defineSignal,
  defineUpdate,
  defineWorkflow,
} from "./builder.js";

describe("Helper Functions", () => {
  describe("defineActivity", () => {
    it("should create an activity definition", () => {
      const activity = defineActivity({
        input: z.object({ value: z.string() }),
        output: z.object({ result: z.string() }),
      });

      expect(activity).toEqual(
        expect.objectContaining({
          input: expect.any(Object),
          output: expect.any(Object),
        }),
      );
    });
  });

  describe("defineSignal", () => {
    it("should create a signal definition", () => {
      const signal = defineSignal({
        input: z.object({ message: z.string() }),
      });

      expect(signal).toEqual(
        expect.objectContaining({
          input: expect.any(Object),
        }),
      );
    });

    it("should work with primitive types", () => {
      const signal = defineSignal({
        input: z.string(),
      });

      expect(signal).toEqual(
        expect.objectContaining({
          input: expect.any(Object),
        }),
      );
    });

    it("should materialize an undefined-input schema when input is omitted", async () => {
      const signal = defineSignal();

      expect(signal.input["~standard"].vendor).toBe("temporal-contract");
      expect(await signal.input["~standard"].validate(undefined)).toEqual({ value: undefined });
      // `null` is accepted defensively — JSON payload converters cannot
      // represent `undefined` and may round-trip it as `null`.
      expect(await signal.input["~standard"].validate(null)).toEqual({ value: undefined });

      const rejected = await signal.input["~standard"].validate({ some: "payload" });
      expect(rejected.issues).toBeDefined();
    });

    it("should treat an empty definition object like an omitted input", async () => {
      const signal = defineSignal({});

      expect(signal.input["~standard"].vendor).toBe("temporal-contract");
      expect(await signal.input["~standard"].validate(undefined)).toEqual({ value: undefined });
    });
  });

  describe("defineQuery", () => {
    it("should create a query definition", () => {
      const query = defineQuery({
        input: z.object({ id: z.string() }),
        output: z.object({ status: z.string() }),
      });

      expect(query).toEqual(
        expect.objectContaining({
          input: expect.any(Object),
          output: expect.any(Object),
        }),
      );
    });

    it("should work with void input", () => {
      const query = defineQuery({
        input: z.void(),
        output: z.object({ count: z.number() }),
      });

      expect(query).toEqual(
        expect.objectContaining({
          input: expect.any(Object),
          output: expect.any(Object),
        }),
      );
    });

    it("should materialize an undefined-input schema when input is omitted", async () => {
      const query = defineQuery({
        output: z.object({ count: z.number() }),
      });

      expect(query.input["~standard"].vendor).toBe("temporal-contract");
      expect(query.output["~standard"].vendor).toBe("zod");
      expect(await query.input["~standard"].validate(undefined)).toEqual({ value: undefined });

      const rejected = await query.input["~standard"].validate("unexpected");
      expect(rejected.issues).toBeDefined();
    });
  });

  describe("defineUpdate", () => {
    it("should create an update definition", () => {
      const update = defineUpdate({
        input: z.object({ value: z.number() }),
        output: z.object({ newValue: z.number() }),
      });

      expect(update).toEqual(
        expect.objectContaining({
          input: expect.any(Object),
          output: expect.any(Object),
        }),
      );
    });

    it("should materialize an undefined-input schema when input is omitted", async () => {
      const update = defineUpdate({
        output: z.object({ restocked: z.boolean() }),
      });

      expect(update.input["~standard"].vendor).toBe("temporal-contract");
      expect(await update.input["~standard"].validate(undefined)).toEqual({ value: undefined });

      const rejected = await update.input["~standard"].validate(42);
      expect(rejected.issues).toBeDefined();
    });
  });

  describe("defineWorkflow", () => {
    it("should create a workflow definition", () => {
      const workflow = defineWorkflow({
        input: z.object({ orderId: z.string() }),
        output: z.object({ status: z.string() }),
      });

      expect(workflow).toEqual(
        expect.objectContaining({
          input: expect.any(Object),
          output: expect.any(Object),
        }),
      );
    });

    it("should support all interaction types", () => {
      const workflow = defineWorkflow({
        input: z.object({ orderId: z.string() }),
        output: z.object({ status: z.string() }),
        activities: {
          processPayment: {
            input: z.object({ amount: z.number() }),
            output: z.object({ success: z.boolean() }),
          },
        },
        signals: {
          cancelOrder: {
            input: z.object({ reason: z.string() }),
          },
        },
        queries: {
          getStatus: {
            input: z.void(),
            output: z.object({ status: z.string() }),
          },
        },
        updates: {
          updateAmount: {
            input: z.object({ newAmount: z.number() }),
            output: z.object({ updated: z.boolean() }),
          },
        },
      });

      expect(workflow).toEqual(
        expect.objectContaining({
          activities: expect.objectContaining({
            processPayment: expect.objectContaining({
              input: expect.any(Object),
              output: expect.any(Object),
            }),
          }),
          signals: expect.objectContaining({
            cancelOrder: expect.objectContaining({ input: expect.any(Object) }),
          }),
          queries: expect.objectContaining({
            getStatus: expect.objectContaining({
              input: expect.any(Object),
              output: expect.any(Object),
            }),
          }),
          updates: expect.objectContaining({
            updateAmount: expect.objectContaining({
              input: expect.any(Object),
              output: expect.any(Object),
            }),
          }),
        }),
      );
    });
  });
});
