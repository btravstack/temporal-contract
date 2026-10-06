/**
 * Contract-derived workflow IDs.
 *
 * The point of the feature is that the ID and the start policy stop living in
 * different places: `startPolicy: "once-per-id"` protects nothing if a caller
 * is free to pass `crypto.randomUUID()`. These tests pin the ID that actually
 * reaches Temporal, which is the only thing the policy sees.
 */
import { defineContract, defineWorkflow } from "@temporal-contract/contract";
import { TechnicalError } from "@temporal-contract/contract/errors";
import type { Client } from "@temporalio/client";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { TypedClient } from "./client.js";
import { WorkflowValidationError } from "./errors.js";

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
      signals: { nudge: { input: z.object({}) } },
    }),
    signalled: defineWorkflow({
      input: z.object({ orderId: z.string() }),
      output: z.object({ ok: z.boolean() }),
      workflowId: ({ orderId }) => `signalled-${orderId}`,
      startPolicy: "once-per-id",
      signals: { nudge: { input: z.object({}) } },
    }),
  },
});

function makeClient() {
  const start = vi.fn().mockResolvedValue({
    workflowId: "assigned-by-temporal",
    firstExecutionRunId: "run-1",
    result: vi.fn().mockResolvedValue({ ok: true }),
  });
  const signalWithStart = vi.fn().mockResolvedValue({
    workflowId: "assigned-by-temporal",
    signaledRunId: "run-1",
  });
  const raw = {
    workflow: { start, getHandle: vi.fn(), signalWithStart },
    schedule: { create: vi.fn(), getHandle: vi.fn() },
  } as unknown as Client;

  return { raw, start, signalWithStart };
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
    const { raw, start } = makeClient();
    const orders = await bind(raw);

    await orders.executeWorkflow("processOrder", { args: { orderId: "ORD-9", amount: 1 } });

    expect(start).toHaveBeenCalledWith(
      "processOrder",
      expect.objectContaining({ workflowId: "order-ORD-9" }),
    );
  });

  it("executeWorkflow's result-phase errors name the derived ID, not undefined", async () => {
    const { raw, start } = makeClient();
    start.mockImplementation(async (_type: string, options: { workflowId: string }) => ({
      workflowId: options.workflowId,
      result: vi.fn().mockResolvedValue({ ok: "not-a-boolean" }),
    }));
    const orders = await bind(raw);

    const result = await orders.executeWorkflow("processOrder", {
      args: { orderId: "ORD-9", amount: 1 },
    });

    expect(result.isErr() && result.error).toBeInstanceOf(WorkflowValidationError);
    expect(result.isErr() && (result.error as WorkflowValidationError).workflowId).toBe(
      "order-ORD-9",
    );
  });

  it("derives the ID on signalWithStart too", async () => {
    const { raw, signalWithStart } = makeClient();
    const orders = await bind(raw);

    await orders.signalWithStart("signalled", {
      args: { orderId: "ORD-3" },
      signalName: "nudge",
      signalArgs: {},
    });

    expect(signalWithStart).toHaveBeenCalledWith(
      "signalled",
      expect.objectContaining({ workflowId: "signalled-ORD-3" }),
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

describe("workflowIdFor", () => {
  it("returns the ID a start would derive, from the validated input", async () => {
    const { raw, start } = makeClient();
    const orders = await bind(raw);

    const workflowId = await orders.workflowIdFor("processTrimmed", { orderId: "  ORD-1  " });

    expect(workflowId).toBeOk();
    expect(workflowId.isOk() && workflowId.value).toBe("order-ORD-1");
    expect(start).not.toHaveBeenCalled();
  });

  it("errs with WorkflowValidationError on invalid input", async () => {
    const { raw } = makeClient();
    const orders = await bind(raw);

    const workflowId = await orders.workflowIdFor("processOrder", {
      orderId: "ORD-1",
      amount: "ten" as unknown as number,
    });

    expect(workflowId).toBeErr();
    expect(workflowId.isErr() && workflowId.error).toBeInstanceOf(WorkflowValidationError);
  });

  it("is a defect for a workflow that does not derive its ID", async () => {
    const { raw } = makeClient();
    const orders = await bind(raw);

    const workflowId = await orders.workflowIdFor(
      // @ts-expect-error -- only deriving workflows are accepted
      "auditSweep",
      { day: "2026-09-03" },
    );

    expect(workflowId).toBeDefect();
    expect(workflowId.isDefect() && workflowId.cause).toBeInstanceOf(TechnicalError);
  });
});

describe("contract-derived workflow IDs — types", () => {
  it("rejects a caller-supplied ID on signalWithStart for a derived workflow", async () => {
    const { raw } = makeClient();
    const orders = await bind(raw);

    await orders.signalWithStart("signalled", {
      // @ts-expect-error -- the contract derives this workflow's ID.
      workflowId: "mine",
      args: { orderId: "ORD-1" },
      signalName: "nudge",
      signalArgs: {},
    });
  });

  it("still requires an ID on signalWithStart for a workflow that declares no derivation", async () => {
    const { raw } = makeClient();
    const orders = await bind(raw);

    // @ts-expect-error -- `workflowId` is required for a non-deriving workflow
    await orders.signalWithStart("auditSweep", {
      args: { day: "2026-09-03" },
      signalName: "nudge",
      signalArgs: {},
    });
  });

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
