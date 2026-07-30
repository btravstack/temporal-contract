/**
 * Coverage for the time-skipping helpers.
 *
 * `@temporalio/testing` is mocked so no test-server binary is downloaded:
 * the specs assert that `createTimeSkippingEnvironment` and the fixture
 * factory forward their options to
 * `TestWorkflowEnvironment.createTimeSkipping`, and that the fixture tears
 * the environment down when the vitest worker exits.
 */
import type { TimeSkippingTestWorkflowEnvironmentOptions } from "@temporalio/testing";
import { describe, expect, it, vi } from "vitest";

import { createTimeSkippingEnvironment, createTimeSkippingTest } from "./time-skipping.js";

const mocks = vi.hoisted(() => {
  const teardown = vi.fn(() => Promise.resolve());
  return {
    teardown,
    createTimeSkipping: vi.fn(() => Promise.resolve({ kind: "test-env", teardown })),
  };
});

vi.mock("@temporalio/testing", () => ({
  TestWorkflowEnvironment: { createTimeSkipping: mocks.createTimeSkipping },
}));

const pinnedServer = {
  server: { executable: { type: "cached-download", version: "v1.3.0" } },
} as TimeSkippingTestWorkflowEnvironmentOptions;

// Worker-scoped fixtures must be defined at the top level of the file, not
// inside a describe block.
const timeSkippingIt = createTimeSkippingTest(pinnedServer);

describe("createTimeSkippingEnvironment", () => {
  it("forwards its options to TestWorkflowEnvironment.createTimeSkipping", async () => {
    const env = await createTimeSkippingEnvironment(pinnedServer);

    expect(mocks.createTimeSkipping).toHaveBeenCalledExactlyOnceWith(pinnedServer);
    expect(env).toMatchObject({ kind: "test-env" });
  });
});

describe("createTimeSkippingTest", () => {
  timeSkippingIt("creates the environment with the factory's options", ({ testEnv }) => {
    expect(testEnv).toMatchObject({ kind: "test-env" });
    expect(mocks.createTimeSkipping).toHaveBeenCalledWith(pinnedServer);
    // Worker-scoped fixture: still alive while tests run.
    expect(mocks.teardown).not.toHaveBeenCalled();
  });
});
