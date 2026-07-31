/**
 * Coverage for the `declareWorkflow` brand reader used by `TypedWorker`'s
 * workflow-registration check.
 *
 * The reader is fed arbitrary module exports, so every assertion here is
 * about it staying total: non-functions, unbranded functions, non-string
 * brands, and — the case that matters most — exports whose property read
 * itself throws. A throwing read must degrade to "not a declared workflow",
 * not abort the registration check with an unrelated exception.
 */
import { describe, expect, it } from "vitest";

import { DECLARED_WORKFLOW_BRAND, _internal_declaredWorkflowName } from "./workflow-brand.js";

describe("_internal_declaredWorkflowName", () => {
  it("returns the declared name for a branded function", () => {
    const branded = Object.assign(() => undefined, {
      [DECLARED_WORKFLOW_BRAND]: "orderWorkflow",
    });
    expect(_internal_declaredWorkflowName(branded)).toBe("orderWorkflow");
  });

  it("returns undefined for non-functions and unbranded functions", () => {
    expect(_internal_declaredWorkflowName(undefined)).toBeUndefined();
    expect(_internal_declaredWorkflowName(null)).toBeUndefined();
    expect(_internal_declaredWorkflowName("orderWorkflow")).toBeUndefined();
    expect(
      _internal_declaredWorkflowName({ [DECLARED_WORKFLOW_BRAND]: "notAFunction" }),
    ).toBeUndefined();
    expect(_internal_declaredWorkflowName(() => undefined)).toBeUndefined();
  });

  it("returns undefined when the brand is present but not a string", () => {
    const branded = Object.assign(() => undefined, { [DECLARED_WORKFLOW_BRAND]: 42 });
    expect(_internal_declaredWorkflowName(branded)).toBeUndefined();
  });

  it("returns undefined instead of propagating a throwing getter", () => {
    const hostile = () => undefined;
    Object.defineProperty(hostile, DECLARED_WORKFLOW_BRAND, {
      get() {
        // oxlint-disable-next-line unthrown/no-throw -- test double: simulates a module export whose property read throws
        throw new Error("hostile getter");
      },
    });
    expect(() => _internal_declaredWorkflowName(hostile)).not.toThrow();
    expect(_internal_declaredWorkflowName(hostile)).toBeUndefined();
  });

  it("returns undefined instead of propagating a Proxy `get` trap that throws", () => {
    const hostile = new Proxy(() => undefined, {
      get() {
        // oxlint-disable-next-line unthrown/no-throw -- test double: simulates a Proxy export with a throwing get trap
        throw new Error("hostile trap");
      },
    });
    expect(() => _internal_declaredWorkflowName(hostile)).not.toThrow();
    expect(_internal_declaredWorkflowName(hostile)).toBeUndefined();
  });
});
