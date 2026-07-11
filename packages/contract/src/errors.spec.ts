import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  _internal_buildErrorConstructors,
  _internal_rehydrateContractError,
  ContractError,
} from "./errors.js";

describe("_internal_buildErrorConstructors", () => {
  const declaredErrors = {
    PaymentDeclined: {
      data: z.object({ reason: z.string() }),
      message: "The payment was declined",
      nonRetryable: true,
    },
    OutOfStock: {},
  };

  it("returns an empty map when no errors are declared", () => {
    expect(_internal_buildErrorConstructors(undefined)).toEqual({});
  });

  it("builds a data-taking constructor for errors with a data schema", () => {
    const constructors = _internal_buildErrorConstructors(declaredErrors);

    const error = constructors["PaymentDeclined"]!({ reason: "insufficient_funds" });

    expect(error).toBeInstanceOf(ContractError);
    expect(error.errorName).toBe("PaymentDeclined");
    expect(error.data).toEqual({ reason: "insufficient_funds" });
    expect(error.message).toBe("The payment was declined");
  });

  it("builds an options-only constructor for data-less errors", () => {
    const constructors = _internal_buildErrorConstructors(declaredErrors);

    const error = constructors["OutOfStock"]!();

    expect(error.errorName).toBe("OutOfStock");
    expect(error.data).toBeUndefined();
    // No contract-level default message → generic fallback.
    expect(error.message).toBe('Contract error "OutOfStock"');
  });

  it("lets the call site override the message and attach a cause", () => {
    const constructors = _internal_buildErrorConstructors(declaredErrors);
    const cause = new Error("card network timeout");

    const withData = constructors["PaymentDeclined"]!(
      { reason: "network" },
      { message: "declined after 3 attempts", cause },
    );
    const withoutData = constructors["OutOfStock"]!({ message: "SKU-42 exhausted", cause });

    expect(withData.message).toBe("declined after 3 attempts");
    expect(withData.cause).toBe(cause);
    expect(withoutData.message).toBe("SKU-42 exhausted");
    expect(withoutData.cause).toBe(cause);
  });

  it("carries the unthrown tag for matchTags-style discrimination", () => {
    const constructors = _internal_buildErrorConstructors(declaredErrors);

    expect(constructors["OutOfStock"]!()._tag).toBe("@temporal-contract/ContractError");
  });
});

describe("_internal_rehydrateContractError", () => {
  const declaredErrors = {
    PaymentDeclined: {
      data: z.object({ reason: z.string() }),
      nonRetryable: true,
    },
    OutOfStock: { message: "No stock left" },
  };

  it("rehydrates a matching failure with schema-validated data", async () => {
    const error = await _internal_rehydrateContractError(declaredErrors, {
      type: "PaymentDeclined",
      message: "Card declined",
      details: [{ reason: "insufficient_funds" }],
    });

    expect(error).toBeInstanceOf(ContractError);
    expect(error?.errorName).toBe("PaymentDeclined");
    expect(error?.data).toEqual({ reason: "insufficient_funds" });
    expect(error?.message).toBe("Card declined");
  });

  it("rehydrates a data-less error and keeps the original failure as cause", async () => {
    const failure = { type: "OutOfStock", details: [] };

    const error = await _internal_rehydrateContractError(declaredErrors, failure);

    expect(error?.errorName).toBe("OutOfStock");
    expect(error?.data).toBeUndefined();
    // No message on the wire → contract-level default.
    expect(error?.message).toBe("No stock left");
    expect(error?.cause).toBe(failure);
  });

  it("returns undefined for an undeclared failure type", async () => {
    const error = await _internal_rehydrateContractError(declaredErrors, {
      type: "SOMETHING_ELSE",
      details: [],
    });

    expect(error).toBeUndefined();
  });

  it("returns undefined when the payload no longer validates", async () => {
    const error = await _internal_rehydrateContractError(declaredErrors, {
      type: "PaymentDeclined",
      details: [{ reason: 42 }],
    });

    expect(error).toBeUndefined();
  });

  it("returns undefined when no errors are declared or the failure has no type", async () => {
    await expect(
      _internal_rehydrateContractError(undefined, { type: "PaymentDeclined" }),
    ).resolves.toBeUndefined();
    await expect(_internal_rehydrateContractError(declaredErrors, {})).resolves.toBeUndefined();
  });
});
