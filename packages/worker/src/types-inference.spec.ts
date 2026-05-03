/**
 * Type-level tests for the worker- and client-side inference helpers.
 *
 * The library's headline guarantee is that input/output direction is inverted
 * between worker and client perspectives — getting this wrong silently
 * mistypes every call site, so it's worth pinning at the type level.
 */
import { describe, expectTypeOf, it } from "vitest";
import { z } from "zod";
import { defineActivity } from "@temporal-contract/contract";
import type {
  ClientInferInput,
  ClientInferOutput,
  WorkerInferInput,
  WorkerInferOutput,
} from "./types.js";

describe("worker/client inference duality", () => {
  it("on a transforming schema, client sends InferInput, worker receives InferOutput", () => {
    const activity = defineActivity({
      input: z.object({
        timestamp: z.string().transform((s) => new Date(s)),
      }),
      output: z.object({ ok: z.boolean() }),
    });

    expectTypeOf<ClientInferInput<typeof activity>>().toEqualTypeOf<{ timestamp: string }>();
    expectTypeOf<WorkerInferInput<typeof activity>>().toEqualTypeOf<{ timestamp: Date }>();
  });

  it("on a transforming output, worker returns InferInput, client receives InferOutput", () => {
    const activity = defineActivity({
      input: z.object({}),
      output: z.object({
        when: z.date().transform((d) => d.toISOString()),
      }),
    });

    expectTypeOf<WorkerInferOutput<typeof activity>>().toEqualTypeOf<{ when: Date }>();
    expectTypeOf<ClientInferOutput<typeof activity>>().toEqualTypeOf<{ when: string }>();
  });
});
