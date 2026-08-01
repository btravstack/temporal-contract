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
    // Real, valid options — `proxyActivities` runs the real SDK's
    // `validateActivityOptions` before this throw is reached, and rejects an
    // options object with neither `scheduleToCloseTimeout` nor
    // `startToCloseTimeout`.
    const defaults = { startToCloseTimeout: "1 minute" };

    const build = () =>
      buildRawActivitiesProxy(definitions, undefined, defaults, {
        nonExistent: { startToCloseTimeout: "1 second" },
      });

    expect(build).toThrow(ContractMisuseError);
    expect(build).toThrow(/nonExistent/);
  });
});
