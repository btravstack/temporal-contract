import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  _internal_buildErrorConstructors,
  _internal_rehydrateContractError,
  CONTRACT_ERROR_TAG,
  CONTRACT_ERROR_WIRE_MARKER,
  ContractError,
  onRehydrationMiss,
  TECHNICAL_ERROR_TAG,
  TechnicalError,
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

  it("carries the unthrown tag for match/tag-style discrimination", () => {
    const constructors = _internal_buildErrorConstructors(declaredErrors);

    expect(constructors["OutOfStock"]!()._tag).toBe("@temporal-contract/ContractError");
  });
});

describe("error tag constants", () => {
  it("CONTRACT_ERROR_TAG matches ContractError's _tag", () => {
    const error = new ContractError({ errorName: "X", data: undefined, message: "x" });
    expect(error._tag).toBe(CONTRACT_ERROR_TAG);
  });

  it("TECHNICAL_ERROR_TAG matches TechnicalError's _tag", () => {
    expect(new TechnicalError("boom")._tag).toBe(TECHNICAL_ERROR_TAG);
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

  afterEach(() => {
    onRehydrationMiss(undefined);
  });

  it("rehydrates a matching failure with schema-validated data", async () => {
    const error = await _internal_rehydrateContractError(declaredErrors, {
      type: "PaymentDeclined",
      message: "Card declined",
      details: [{ reason: "insufficient_funds" }, CONTRACT_ERROR_WIRE_MARKER],
    });

    expect(error).toBeInstanceOf(ContractError);
    expect(error?.errorName).toBe("PaymentDeclined");
    expect(error?.data).toEqual({ reason: "insufficient_funds" });
    expect(error?.message).toBe("Card declined");
  });

  it("rehydrates a data-carrying failure without the marker (schema is the gate)", async () => {
    // Pre-marker producers (or hand-built failures) stay rehydratable when
    // the declared data schema validates — the marker corroborates but is
    // not required once a schema gates the payload.
    const error = await _internal_rehydrateContractError(declaredErrors, {
      type: "PaymentDeclined",
      details: [{ reason: "insufficient_funds" }],
    });

    expect(error?.errorName).toBe("PaymentDeclined");
  });

  it("rehydrates a marked data-less error and keeps the original failure as cause", async () => {
    const failure = { type: "OutOfStock", details: [undefined, CONTRACT_ERROR_WIRE_MARKER] };

    const error = await _internal_rehydrateContractError(declaredErrors, failure);

    expect(error?.errorName).toBe("OutOfStock");
    expect(error?.data).toBeUndefined();
    // No message on the wire → contract-level default.
    expect(error?.message).toBe("No stock left");
    expect(error?.cause).toBe(failure);
  });

  it("accepts a marker that lost its identity to serialization (plain object)", async () => {
    const error = await _internal_rehydrateContractError(declaredErrors, {
      type: "OutOfStock",
      details: [null, { $tc: 1 }],
    });

    expect(error?.errorName).toBe("OutOfStock");
  });

  it("does NOT rehydrate a data-less name without the marker (false-positive regression)", async () => {
    // A foreign ApplicationFailure — e.g. produced by qualifyFailure("OutOfStock", { expected: Error })
    // or any handwritten `ApplicationFailure.create({ type: "OutOfStock" })` —
    // must not surface as the typed domain error just because the `type`
    // string matches a declared data-less error.
    const error = await _internal_rehydrateContractError(declaredErrors, {
      type: "OutOfStock",
      message: "same name, different provenance",
      details: [],
    });

    expect(error).toBeUndefined();
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
      details: [{ reason: 42 }, CONTRACT_ERROR_WIRE_MARKER],
    });

    expect(error).toBeUndefined();
  });

  it("returns undefined when no errors are declared or the failure has no type", async () => {
    await expect(
      _internal_rehydrateContractError(undefined, { type: "PaymentDeclined" }),
    ).resolves.toBeUndefined();
    await expect(_internal_rehydrateContractError(declaredErrors, {})).resolves.toBeUndefined();
  });

  describe("onRehydrationMiss diagnostics", () => {
    it("reports a data validation miss with the issues", async () => {
      const handler = vi.fn();
      onRehydrationMiss(handler);
      const failure = {
        type: "PaymentDeclined",
        details: [{ reason: 42 }, CONTRACT_ERROR_WIRE_MARKER],
      };

      await _internal_rehydrateContractError(declaredErrors, failure);

      expect(handler).toHaveBeenCalledExactlyOnceWith({
        errorName: "PaymentDeclined",
        reason: "data-validation-failed",
        issues: expect.arrayContaining([expect.objectContaining({ message: expect.any(String) })]),
        failure,
      });
    });

    it("reports a missing-marker miss for data-less declared names", async () => {
      const handler = vi.fn();
      onRehydrationMiss(handler);
      const failure = { type: "OutOfStock", details: [] };

      await _internal_rehydrateContractError(declaredErrors, failure);

      expect(handler).toHaveBeenCalledExactlyOnceWith({
        errorName: "OutOfStock",
        reason: "missing-wire-marker",
        failure,
      });
    });

    it("does not report undeclared types or successful rehydrations", async () => {
      const handler = vi.fn();
      onRehydrationMiss(handler);

      await _internal_rehydrateContractError(declaredErrors, { type: "SOMETHING_ELSE" });
      await _internal_rehydrateContractError(declaredErrors, {
        type: "PaymentDeclined",
        details: [{ reason: "ok" }, CONTRACT_ERROR_WIRE_MARKER],
      });

      expect(handler).not.toHaveBeenCalled();
    });

    it("swallows a throwing handler — classification still degrades cleanly", async () => {
      onRehydrationMiss(() => {
        // oxlint-disable-next-line unthrown/no-throw -- deliberately hostile diagnostic hook for the swallow test
        throw new Error("hostile logger");
      });

      await expect(
        _internal_rehydrateContractError(declaredErrors, { type: "OutOfStock", details: [] }),
      ).resolves.toBeUndefined();
    });

    it("can be unregistered by passing undefined", async () => {
      const handler = vi.fn();
      onRehydrationMiss(handler);
      onRehydrationMiss(undefined);

      await _internal_rehydrateContractError(declaredErrors, { type: "OutOfStock", details: [] });

      expect(handler).not.toHaveBeenCalled();
    });
  });
});
