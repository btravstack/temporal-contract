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
  };
});

// Import *after* the mock so the workflow module sees our stub.
const { buildRawActivitiesProxy } = await import("./workflow.js");

const activityDef = (input: z.ZodTypeAny, output: z.ZodTypeAny): ActivityDefinition =>
  ({ input, output }) as unknown as ActivityDefinition;

describe("buildRawActivitiesProxy", () => {
  afterEach(() => {
    proxyCalls.length = 0;
  });

  it("uses the workflow's default options when no override is provided", () => {
    const def: Record<string, ActivityDefinition> = {
      a: activityDef(z.object({}), z.object({})),
      b: activityDef(z.object({}), z.object({})),
    };
    const defaults: ActivityOptions = { startToCloseTimeout: "1 minute" };

    const result = buildRawActivitiesProxy(def, undefined, defaults, undefined);

    expect(Object.keys(result).sort()).toEqual(["a", "b"]);
    // Two `proxyActivities` calls (one per name); each receives the defaults.
    expect(proxyCalls).toEqual([defaults, defaults]);
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

    // `fast` keeps the defaults; `slow` gets the override-merged options.
    expect(proxyCalls).toContainEqual(defaults);
    expect(proxyCalls).toContainEqual({
      startToCloseTimeout: "10 minutes",
      retry: { maximumAttempts: 10 },
    });
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
      {
        startToCloseTimeout: "1 minute",
        retry: { maximumAttempts: 10 }, // initialInterval is gone — shallow merge
      },
    ]);
  });

  it("merges workflow-local and global activities into one map", () => {
    const workflowDefs: Record<string, ActivityDefinition> = {
      local: activityDef(z.object({}), z.object({})),
    };
    const globalDefs: Record<string, ActivityDefinition> = {
      global: activityDef(z.object({}), z.object({})),
    };
    const defaults: ActivityOptions = { startToCloseTimeout: "30 seconds" };

    const result = buildRawActivitiesProxy(workflowDefs, globalDefs, defaults, undefined);

    expect(Object.keys(result).sort()).toEqual(["global", "local"]);
  });

  it("returns no activities when none are declared", () => {
    const result = buildRawActivitiesProxy(undefined, undefined, {}, undefined);
    expect(result).toEqual({});
    expect(proxyCalls).toEqual([]);
  });
});
