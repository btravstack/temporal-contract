/**
 * Contract-derived workflow IDs.
 *
 * The point of the feature is that the ID and the start policy stop living in
 * different places: `startPolicy: "once-per-id"` protects nothing if a caller
 * is free to pass `crypto.randomUUID()`. These tests pin the ID that actually
 * reaches Temporal, which is the only thing the policy sees.
 */
import { defineContract, defineWorkflow } from "@temporal-contract/contract";
import type { Client } from "@temporalio/client";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { TypedClient } from "./client.js";

const derivedContract = defineContract({
  taskQueue: "orders",
  workflows: {
    // Derives its ID: one execution per order, ever.
    processOrder: defineWorkflow({
      input: z.object({ orderId: z.string(), amount: z.number() }),
      output: z.object({ ok: z.boolean() }),
      workflowId: ({ orderId }) => `order-${orderId}`,
      startPolicy: "once-per-id",
    }),
    // Derives from a schema that trims, so the ID must come from the
    // post-parse value.
    processTrimmed: defineWorkflow({
      input: z.object({ orderId: z.string().transform((v) => v.trim()) }),
      output: z.object({ ok: z.boolean() }),
      workflowId: ({ orderId }) => `order-${orderId}`,
      startPolicy: "once-per-id",
    }),
    // Declares no derivation: the caller still supplies the ID.
    auditSweep: defineWorkflow({
      input: z.object({ day: z.string() }),
      output: z.object({ ok: z.boolean() }),
      startPolicy: "allow-duplicate",
    }),
  },
});

function makeClient() {
  const start = vi.fn().mockResolvedValue({
    workflowId: "assigned-by-temporal",
    firstExecutionRunId: "run-1",
  });
  const execute = vi.fn().mockResolvedValue({ ok: true });
  const raw = {
    workflow: { start, execute, getHandle: vi.fn(), signalWithStart: vi.fn() },
    schedule: { create: vi.fn(), getHandle: vi.fn() },
  } as unknown as Client;

  return { raw, start, execute };
}

const bind = async (raw: Client) =>
  (await TypedClient.create({ client: raw }).get()).for(derivedContract);

describe("contract-derived workflow IDs", () => {
  it("derives the ID from the payload on startWorkflow", async () => {
    const { raw, start } = makeClient();
    const orders = await bind(raw);

    await orders.startWorkflow("processOrder", { args: { orderId: "ORD-1", amount: 10 } });

    expect(start).toHaveBeenCalledWith(
      "processOrder",
      expect.objectContaining({ workflowId: "order-ORD-1" }),
    );
  });

  it("derives the same ID for the same payload — which is what makes the policy bite", async () => {
    const { raw, start } = makeClient();
    const orders = await bind(raw);

    await orders.startWorkflow("processOrder", { args: { orderId: "ORD-1", amount: 10 } });
    await orders.startWorkflow("processOrder", { args: { orderId: "ORD-1", amount: 10 } });

    const [first, second] = start.mock.calls;
    expect(first?.[1].workflowId).toBe(second?.[1].workflowId);
    // And the policy that acts on it still travels with the start.
    expect(first?.[1].workflowIdReusePolicy).toBe("REJECT_DUPLICATE");
  });

  it("derives from the VALIDATED input, after schema transforms", async () => {
    // Deriving from the raw payload would give "  ORD-1  " and "ORD-1" two
    // different IDs — two executions for one order, and the collision the
    // derivation exists to force never happens.
    const { raw, start } = makeClient();
    const orders = await bind(raw);

    await orders.startWorkflow("processTrimmed", { args: { orderId: "  ORD-1  " } });

    expect(start).toHaveBeenCalledWith(
      "processTrimmed",
      expect.objectContaining({ workflowId: "order-ORD-1" }),
    );
  });

  it("derives the ID on executeWorkflow too", async () => {
    const { raw, execute } = makeClient();
    const orders = await bind(raw);

    await orders.executeWorkflow("processOrder", { args: { orderId: "ORD-9", amount: 1 } });

    expect(execute).toHaveBeenCalledWith(
      "processOrder",
      expect.objectContaining({ workflowId: "order-ORD-9" }),
    );
  });

  it("still uses the caller's ID for a workflow that declares no derivation", async () => {
    const { raw, start } = makeClient();
    const orders = await bind(raw);

    await orders.startWorkflow("auditSweep", {
      workflowId: "sweep-2026-09-03",
      args: { day: "2026-09-03" },
    });

    expect(start).toHaveBeenCalledWith(
      "auditSweep",
      expect.objectContaining({ workflowId: "sweep-2026-09-03" }),
    );
  });
});

describe("contract-derived workflow IDs — types", () => {
  it("rejects a caller-supplied ID for a derived workflow", async () => {
    const { raw } = makeClient();
    const orders = await bind(raw);

    await orders.startWorkflow("processOrder", {
      // @ts-expect-error -- the contract derives this workflow's ID; supplying
      // one is what defeats `once-per-id`.
      workflowId: crypto.randomUUID(),
      args: { orderId: "ORD-1", amount: 10 },
    });
  });

  it("still requires an ID for a workflow that declares no derivation", async () => {
    const { raw } = makeClient();
    const orders = await bind(raw);

    // @ts-expect-error -- `workflowId` is required for a non-deriving workflow
    await orders.startWorkflow("auditSweep", { args: { day: "2026-09-03" } });
  });
});
