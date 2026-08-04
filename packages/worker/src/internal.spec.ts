import type { ActivityDefinition } from "@temporal-contract/contract";
/**
 * Runtime coverage for the two `ContractMisuseError` fail-fast paths in
 * `buildRawActivitiesProxy` (see `internal.ts:97-217` for the merge-precedence
 * design these guard). Both throws are reachable without a Temporal
 * workflow environment or an SDK mock:
 *
 * - The "activityOptions omitted" throw (`internal.ts:139`) fires *before*
 *   the first `proxyActivities` call — it never touches `@temporalio/workflow`.
 * - The "unknown activityOptionsByName key" throw (`internal.ts:165`) fires
 *   *after* `proxyActivities(defaultOptions)`, but `proxyActivities` itself
 *   only validates the options object and returns a `Proxy` — it doesn't
 *   require a workflow activator until one of its synthesized functions is
 *   actually invoked, which this test never does. Real, valid
 *   `ActivityOptions` (a `startToCloseTimeout`) are passed so the real SDK's
 *   own `validateActivityOptions` doesn't reject the call — the old spec's
 *   `{}` defaults needed a mock only to dodge that validation.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { ContractMisuseError } from "./errors.js";
import { buildRawActivitiesProxy } from "./internal.js";

const activityDef = (): ActivityDefinition =>
  ({ input: z.object({}), output: z.object({}) }) as unknown as ActivityDefinition;

describe("buildRawActivitiesProxy — declaration-time misuse", () => {
  it("throws ContractMisuseError when activityOptions is omitted and an activity has no options of its own", () => {
    const definitions: Record<string, ActivityDefinition> = {
      uncovered: activityDef(),
    };

    const build = () => buildRawActivitiesProxy(definitions, undefined, undefined, undefined);

    // No `proxyActivities` call happens on this path — the throw fires before
    // it, so no valid `ActivityOptions` are needed to reach it.
    expect(build).toThrow(ContractMisuseError);
    expect(build).toThrow(/uncovered/);
  });

  it("throws ContractMisuseError when an activityOptionsByName key matches no declared activity", () => {
    const definitions: Record<string, ActivityDefinition> = {
      knownActivity: activityDef(),
    };
    // Real, valid, and BOUNDED options: `defaults` must clear the
    // unconditional per-attempt/total bound guard (`internal.ts`) before this
    // throw is reached, and `proxyActivities` runs the real SDK's
    // `validateActivityOptions` on top of that — an options object with
    // neither `scheduleToCloseTimeout` nor `startToCloseTimeout` would fail
    // there too.
    const defaults = { startToCloseTimeout: "1 minute", retry: { maximumAttempts: 3 } };

    const build = () =>
      buildRawActivitiesProxy(definitions, undefined, defaults, {
        nonExistent: { startToCloseTimeout: "1 second" },
      });

    expect(build).toThrow(ContractMisuseError);
    expect(build).toThrow(/nonExistent/);
  });
});

describe("buildRawActivitiesProxy — bound enforcement", () => {
  const bounded = { startToCloseTimeout: "1 minute", retry: { maximumAttempts: 3 } };

  it("rejects a contract options bag with retry but no timeout", () => {
    const definitions: Record<string, ActivityDefinition> = {
      retryOnly: {
        input: z.object({}),
        output: z.object({}),
        activityOptions: { retry: { maximumAttempts: 3 } },
      } as unknown as ActivityDefinition,
    };

    const build = () => buildRawActivitiesProxy(definitions, undefined, undefined, undefined);

    expect(build).toThrow(ContractMisuseError);
    expect(build).toThrow(/retryOnly/);
    expect(build).toThrow(/per-attempt/);
  });

  it("rejects an activity whose merged options have no total bound", () => {
    const definitions: Record<string, ActivityDefinition> = {
      noTotal: activityDef(),
    };

    const build = () =>
      buildRawActivitiesProxy(
        definitions,
        undefined,
        { startToCloseTimeout: "1 minute" },
        undefined,
      );

    expect(build).toThrow(ContractMisuseError);
    expect(build).toThrow(/noTotal/);
    expect(build).toThrow(/total bound/);
  });

  it("runs even when declareWorkflow supplies activityOptions — the old bypass", () => {
    // The previous guard was wrapped in `if (!defaultOptions)`, so ANY truthy
    // `activityOptions` skipped it for every activity. This is that exact input.
    const definitions: Record<string, ActivityDefinition> = {
      bypassed: activityDef(),
    };

    const build = () =>
      buildRawActivitiesProxy(definitions, undefined, { retry: { maximumAttempts: 3 } }, undefined);

    expect(build).toThrow(ContractMisuseError);
    expect(build).toThrow(/bypassed/);
  });

  it("rejects an override that drops the bound via the shallow retry merge", () => {
    // Both layers look bounded in isolation: the default has maximumAttempts,
    // the override has a retry block. The shallow merge replaces `retry`
    // wholesale, so the merged result has NO total bound. Only a merged check
    // can see this.
    const definitions: Record<string, ActivityDefinition> = {
      merged: activityDef(),
    };

    const build = () =>
      buildRawActivitiesProxy(definitions, undefined, bounded, {
        merged: { retry: { initialInterval: "2s" } },
      });

    expect(build).toThrow(ContractMisuseError);
    expect(build).toThrow(/merged/);
    expect(build).toThrow(/total bound/);
  });

  it("accepts scheduleToCloseTimeout alone — it satisfies both rules", () => {
    const definitions: Record<string, ActivityDefinition> = {
      ok: activityDef(),
    };

    expect(() =>
      buildRawActivitiesProxy(
        definitions,
        undefined,
        { scheduleToCloseTimeout: "10 minutes" },
        undefined,
      ),
    ).not.toThrow();
  });

  it("names every offender in one error, not just the first", () => {
    const definitions: Record<string, ActivityDefinition> = {
      first: activityDef(),
      second: activityDef(),
    };

    const build = () => buildRawActivitiesProxy(definitions, undefined, undefined, undefined);

    expect(build).toThrow(/first/);
    expect(build).toThrow(/second/);
  });

  it("does not construct a default proxy no activity relies on", () => {
    // Every activity carries its own bounded options, so `defaultOptions` is
    // never the effective options for anything. Constructing a proxy from it
    // would throw Temporal's plain TypeError (→ workflow-task stall) for
    // options that would never have been used.
    const definitions: Record<string, ActivityDefinition> = {
      covered: {
        input: z.object({}),
        output: z.object({}),
        activityOptions: bounded,
      } as unknown as ActivityDefinition,
    };

    expect(() =>
      buildRawActivitiesProxy(
        definitions,
        undefined,
        { retry: { initialInterval: "2s" } },
        undefined,
      ),
    ).not.toThrow();
  });
});
