/**
 * The activity idempotency key: declared on the contract, derived from the
 * validated input, handed to the implementation.
 *
 * Temporal runs an activity at least once, so the value these tests pin is
 * the one a payment gateway will see on the second run. What matters is that
 * it is **identical** across runs of the same input, and that it is derived
 * from the input the implementation actually receives.
 */
import { defineActivity, type ContractDefinition } from "@temporal-contract/contract";
import { OkAsync } from "unthrown";
import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";

import {
  declareActivitiesHandler,
  declareActivityMiddleware,
  type ActivityImplementationHelpers,
} from "./activity.js";

const contract = {
  taskQueue: "payments",
  workflows: {
    checkout: {
      input: z.object({ orderId: z.string() }),
      output: z.object({ done: z.boolean() }),
      idempotency: "retry-if-failed",
    },
  },
  activities: {
    // Declares a key: the customer + amount pair a gateway must not charge twice.
    charge: {
      input: z.object({ customerId: z.string(), amount: z.number() }),
      output: z.object({ key: z.string() }),
      idempotencyKey: ({ customerId, amount }) => `${customerId}:${amount}`,
    },
    // Declares none: reading a balance twice is harmless.
    readBalance: {
      input: z.object({ customerId: z.string() }),
      output: z.object({ key: z.string() }),
    },
    // The input schema transforms, so the key must be derived AFTER the parse.
    chargeTrimmed: {
      input: z.object({ customerId: z.string().transform((v) => v.trim()) }),
      output: z.object({ key: z.string() }),
      idempotencyKey: ({ customerId }) => customerId,
    },
  },
} satisfies ContractDefinition;

/** Hands the received key straight back so a test can assert on it. */
const echoKey = ({ idempotencyKey }: { idempotencyKey: string | undefined }) =>
  OkAsync({ key: String(idempotencyKey) });

describe("activity idempotency key", () => {
  it("hands the declared key, derived from the input, to the implementation", async () => {
    const activities = declareActivitiesHandler({
      contract,
      activities: {
        charge: echoKey,
        readBalance: echoKey,
        chargeTrimmed: echoKey,
      },
    });

    await expect(activities.charge({ customerId: "CUST-1", amount: 149.97 })).resolves.toEqual({
      key: "CUST-1:149.97",
    });
  });

  it("produces the SAME key on a re-run of the same input", async () => {
    // The at-least-once guarantee in one assertion: two invocations, one key.
    const activities = declareActivitiesHandler({
      contract,
      activities: { charge: echoKey, readBalance: echoKey, chargeTrimmed: echoKey },
    });

    const first = await activities.charge({ customerId: "CUST-1", amount: 149.97 });
    const second = await activities.charge({ customerId: "CUST-1", amount: 149.97 });

    expect(first).toEqual(second);
  });

  it("hands over undefined when the activity declares no key", async () => {
    const activities = declareActivitiesHandler({
      contract,
      activities: { charge: echoKey, readBalance: echoKey, chargeTrimmed: echoKey },
    });

    await expect(activities.readBalance({ customerId: "CUST-1" })).resolves.toEqual({
      key: "undefined",
    });
  });

  it("derives from the VALIDATED input, after schema transforms", async () => {
    // Deriving from the raw payload would key "  CUST-1  " and "CUST-1"
    // differently — two keys for one customer, and a double charge.
    const activities = declareActivitiesHandler({
      contract,
      activities: { charge: echoKey, readBalance: echoKey, chargeTrimmed: echoKey },
    });

    await expect(activities.chargeTrimmed({ customerId: "  CUST-1  " })).resolves.toEqual({
      key: "CUST-1",
    });
  });

  it("re-keys on a middleware input substitution", async () => {
    // Middleware may replace the input (re-validated at the boundary); the
    // key must describe what actually ran, not what the caller sent.
    const rewrite = declareActivityMiddleware(({ input }, next) => {
      const typed = input as { customerId: string; amount: number };
      return next({ input: { ...typed, customerId: "CUST-REWRITTEN" } });
    });

    const activities = declareActivitiesHandler({
      contract,
      middleware: rewrite,
      activities: { charge: echoKey, readBalance: echoKey, chargeTrimmed: echoKey },
    });

    await expect(activities.charge({ customerId: "CUST-1", amount: 10 })).resolves.toEqual({
      key: "CUST-REWRITTEN:10",
    });
  });
});

describe("activity idempotency key — types", () => {
  // `defineActivity` re-states the slot against the bound input schema, so the
  // derivation's parameter is contextually typed: no annotation needed, and a
  // field the input doesn't have is a compile error.
  const charge = defineActivity({
    input: z.object({ customerId: z.string(), amount: z.number() }),
    output: z.object({ ok: z.boolean() }),
    idempotencyKey: ({ customerId, amount }) => `${customerId}:${amount}`,
  });

  const readBalance = defineActivity({
    input: z.object({ customerId: z.string() }),
    output: z.object({ ok: z.boolean() }),
  });

  it("types the helper as string when the activity declares a key", () => {
    expectTypeOf<
      ActivityImplementationHelpers<typeof charge>["idempotencyKey"]
    >().toEqualTypeOf<string>();
  });

  it("types the helper as undefined when it does not", () => {
    // Not `string | undefined`: reaching for a key that was never declared is
    // a type error, rather than an `undefined` reaching a payment gateway.
    expectTypeOf<
      ActivityImplementationHelpers<typeof readBalance>["idempotencyKey"]
    >().toEqualTypeOf<undefined>();
  });

  it("rejects a derivation reading a field the input does not have", () => {
    defineActivity({
      input: z.object({ customerId: z.string() }),
      output: z.object({ ok: z.boolean() }),
      // @ts-expect-error -- `amount` is not on this activity's input
      idempotencyKey: ({ amount }) => String(amount),
    });
  });
});
