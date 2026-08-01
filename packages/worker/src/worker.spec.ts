import { describe, expect, it } from "vitest";

import { workflowsPathFromURL } from "./worker.js";

/**
 * `workflowsPathFromURL` is a pure path-resolution helper — no Temporal
 * types touched, nothing to mock. Every other `TypedWorker` behavior
 * (option mapping, registration-check outcomes, run/shutdown lifecycle) is
 * only provable by asserting a real effect against Temporal, so it lives in
 * `__tests__/registration.inprocess.spec.ts` and the other
 * `*.inprocess.spec.ts` suites instead — see
 * `packages/testing/src/no-sdk-mocks.spec.ts`.
 */
describe("workflowsPathFromURL", () => {
  it("should resolve a relative .js path against the base URL", () => {
    // GIVEN
    const baseURL = "file:///home/user/project/worker.js";
    const relativePath = "./workflows.js";

    // WHEN
    const result = workflowsPathFromURL(baseURL, relativePath);

    // THEN
    expect(result).toContain("workflows");
    expect(result).toContain(".js");
  });

  it("should resolve a relative .ts path against the base URL", () => {
    // GIVEN
    const baseURL = "file:///home/user/project/worker.ts";
    const relativePath = "./workflows.ts";

    // WHEN
    const result = workflowsPathFromURL(baseURL, relativePath);

    // THEN
    expect(result).toContain("workflows");
    expect(result).toContain(".ts");
  });

  it("should resolve path without extension when caller omits it", () => {
    // GIVEN
    const baseURL = "file:///home/user/project/worker.js";
    const relativePath = "./workflows";

    // WHEN
    const result = workflowsPathFromURL(baseURL, relativePath);

    // THEN
    expect(result).toBe("/home/user/project/workflows");
  });
});
