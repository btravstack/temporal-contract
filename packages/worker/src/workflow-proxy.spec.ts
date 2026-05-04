/**
 * Runtime coverage for `buildRawActivitiesProxy` — the helper that wires
 * per-activity `ActivityOptions` overrides into Temporal's `proxyActivities`.
 *
 * Mocks `@temporalio/workflow` so the helper is callable outside a real
 * workflow context, and asserts that each activity name is reachable through
 * a `proxyActivities` call carrying *that activity's* effective options
 * (default ⊕ override).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ActivityOptions } from "@temporalio/workflow";
import type { ActivityDefinition } from "@temporal-contract/contract";
import { defineActivity, defineContract, defineWorkflow } from "@temporal-contract/contract";

const proxyCalls: ActivityOptions[] = [];

vi.mock("@temporalio/workflow", async () => {
  const actual =
    await vi.importActual<typeof import("@temporalio/workflow")>("@temporalio/workflow");
  return {
    ...actual,
    proxyActivities: (options: ActivityOptions) => {
      proxyCalls.push(options);
      // Return a Proxy that synthesizes a no-op function for any property
      // access. `buildRawActivitiesProxy` will read one property per activity
      // name and store the resulting function.
      return new Proxy({} as Record<string, (...args: unknown[]) => Promise<unknown>>, {
        get:
          (_target, prop) =>
          (..._args: unknown[]) =>
            Promise.resolve({ stub: String(prop) }),
      });
    },
    workflowInfo: () => ({ workflowId: "test-wf", runId: "test-run" }),
  };
});

// Import *after* the mock so the helper module sees our stub.
const { buildRawActivitiesProxy } = await import("./internal.js");
const { declareWorkflow } = await import("./workflow.js");

const activityDef = (input: z.ZodTypeAny, output: z.ZodTypeAny): ActivityDefinition =>
  ({ input, output }) as unknown as ActivityDefinition;

describe("buildRawActivitiesProxy", () => {
  afterEach(() => {
    proxyCalls.length = 0;
  });

  it("makes a single proxyActivities call when no override is provided (fast path)", () => {
    // Regression: previously this path made one proxyActivities call per
    // activity name. The optimized path delegates everything to one default
    // proxy, matching the original (pre-`activityOptionsByName`) behavior.
    const def: Record<string, ActivityDefinition> = {
      a: activityDef(z.object({}), z.object({})),
      b: activityDef(z.object({}), z.object({})),
    };
    const defaults: ActivityOptions = { startToCloseTimeout: "1 minute" };

    const result = buildRawActivitiesProxy(def, undefined, defaults, undefined);

    // Exactly one proxyActivities call, with the default options.
    expect(proxyCalls).toEqual([defaults]);
    // Lookups by name still work — the returned object is the proxy itself.
    expect(typeof result["a"]).toBe("function");
    expect(typeof result["b"]).toBe("function");
  });

  it("treats an empty overrides object as the fast path", () => {
    const def: Record<string, ActivityDefinition> = {
      a: activityDef(z.object({}), z.object({})),
    };
    const defaults: ActivityOptions = { startToCloseTimeout: "1 minute" };

    buildRawActivitiesProxy(def, undefined, defaults, {});

    expect(proxyCalls).toEqual([defaults]);
  });

  it("shallow-merges per-activity overrides over the defaults", () => {
    const def: Record<string, ActivityDefinition> = {
      fast: activityDef(z.object({}), z.object({})),
      slow: activityDef(z.object({}), z.object({})),
    };
    const defaults: ActivityOptions = {
      startToCloseTimeout: "1 minute",
      retry: { maximumAttempts: 3 },
    };
    const overrides = {
      slow: {
        startToCloseTimeout: "10 minutes",
        retry: { maximumAttempts: 10 },
      },
    } satisfies Partial<Record<string, ActivityOptions>>;

    buildRawActivitiesProxy(def, undefined, defaults, overrides);

    // One default proxy + one override proxy — not one per activity name.
    expect(proxyCalls).toEqual([
      defaults,
      { startToCloseTimeout: "10 minutes", retry: { maximumAttempts: 10 } },
    ]);
  });

  it("override fields replace default fields without deep-merging", () => {
    // Override's `retry` block fully replaces the default's. This matches
    // Temporal's single-options-per-`proxyActivities`-call semantics —
    // there is no nested merge.
    const def: Record<string, ActivityDefinition> = {
      slow: activityDef(z.object({}), z.object({})),
    };
    const defaults: ActivityOptions = {
      startToCloseTimeout: "1 minute",
      retry: { maximumAttempts: 3, initialInterval: "1 second" },
    };
    const overrides = {
      slow: { retry: { maximumAttempts: 10 } },
    } satisfies Partial<Record<string, ActivityOptions>>;

    buildRawActivitiesProxy(def, undefined, defaults, overrides);

    expect(proxyCalls).toEqual([
      defaults,
      {
        startToCloseTimeout: "1 minute",
        retry: { maximumAttempts: 10 }, // initialInterval is gone — shallow merge
      },
    ]);
  });

  it("override path: name lookup returns the override proxy for overridden names and falls back to default for the rest", () => {
    const def: Record<string, ActivityDefinition> = {
      fast: activityDef(z.object({}), z.object({})),
      slow: activityDef(z.object({}), z.object({})),
    };
    const defaults: ActivityOptions = { startToCloseTimeout: "1 minute" };
    const overrides = {
      slow: { startToCloseTimeout: "10 minutes" },
    } satisfies Partial<Record<string, ActivityOptions>>;

    const result = buildRawActivitiesProxy(def, undefined, defaults, overrides);

    // Both names resolve to functions — `fast` via the default proxy
    // fallback, `slow` via the override proxy. The returned Proxy makes the
    // distinction transparent to downstream code.
    expect(typeof result["fast"]).toBe("function");
    expect(typeof result["slow"]).toBe("function");
  });

  it("rejects override keys that don't match any declared activity", () => {
    // A typo in `activityOptionsByName` is caught by the type system at
    // declaration sites, but a raw call (or a stale options bag from a
    // renamed activity) shouldn't silently spin up a proxy for a name that
    // can never be invoked. Surface a clear error instead.
    const def: Record<string, ActivityDefinition> = {
      knownActivity: activityDef(z.object({}), z.object({})),
    };
    expect(() =>
      buildRawActivitiesProxy(
        def,
        undefined,
        {},
        {
          nonExistent: { startToCloseTimeout: "1 second" },
        },
      ),
    ).toThrow(/nonExistent/);
  });

  it("merges workflow-local and global activities into one lookup space", () => {
    const workflowDefs: Record<string, ActivityDefinition> = {
      local: activityDef(z.object({}), z.object({})),
    };
    const globalDefs: Record<string, ActivityDefinition> = {
      global: activityDef(z.object({}), z.object({})),
    };
    const defaults: ActivityOptions = { startToCloseTimeout: "30 seconds" };

    const result = buildRawActivitiesProxy(workflowDefs, globalDefs, defaults, undefined);

    expect(typeof result["local"]).toBe("function");
    expect(typeof result["global"]).toBe("function");
  });
});

describe("declareWorkflow hoists proxyActivities to declaration time", () => {
  // Temporal SDK docs are explicit that `proxyActivities` is intended for
  // module-scope use — it registers stub functions and may carry bookkeeping
  // (validator pre-registration, payload-converter caching) that breaks if
  // re-invoked on every workflow run. Previously `buildRawActivitiesProxy`
  // (and therefore `proxyActivities`) was called inside the closure returned
  // from `declareWorkflow`, which Temporal invokes for every workflow start.
  // This test pins the new behaviour: the proxy is built exactly once at
  // `declareWorkflow` declaration time and re-used across every invocation.
  const hoistContract = defineContract({
    taskQueue: "hoist-q",
    workflows: {
      probe: defineWorkflow({
        input: z.object({ x: z.number() }),
        output: z.object({ ok: z.boolean() }),
        activities: {
          touch: defineActivity({ input: z.object({}), output: z.object({}) }),
        },
      }),
    },
  });

  afterEach(() => {
    proxyCalls.length = 0;
  });

  it("calls proxyActivities once at declareWorkflow time, not per invocation", async () => {
    proxyCalls.length = 0;

    const handler = declareWorkflow({
      workflowName: "probe",
      contract: hoistContract,
      activityOptions: { startToCloseTimeout: "1 minute" },
      implementation: async () => ({ ok: true }),
    });

    // After declaration, proxyActivities should already have run exactly once.
    expect(proxyCalls).toHaveLength(1);

    // Multiple invocations must not trigger additional proxyActivities calls —
    // the proxy is shared, matching the SDK's documented module-scope contract.
    await handler({ x: 1 });
    await handler({ x: 2 });
    await handler({ x: 3 });

    expect(proxyCalls).toHaveLength(1);
  });

  it("does not call proxyActivities at all when the workflow has no activities", async () => {
    proxyCalls.length = 0;
    const noActivityContract = defineContract({
      taskQueue: "no-act-q",
      workflows: {
        probe: defineWorkflow({
          input: z.object({ x: z.number() }),
          output: z.object({ ok: z.boolean() }),
        }),
      },
    });

    const handler = declareWorkflow({
      workflowName: "probe",
      contract: noActivityContract,
      activityOptions: { startToCloseTimeout: "1 minute" },
      implementation: async () => ({ ok: true }),
    });

    await handler({ x: 1 });
    await handler({ x: 2 });

    expect(proxyCalls).toHaveLength(0);
  });
});
