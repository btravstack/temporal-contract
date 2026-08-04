# Safe-by-default option shapes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Guarantee that every reachable activity has both a per-attempt and a total bound, and that every child-workflow call states its parent-close policy — both enforced at declaration/compile time rather than discovered as a hung workflow.

**Architecture:** Two independent components. (1) A pure, unit-testable bounds module (`activity-bounds.ts`) consumed by `buildRawActivitiesProxy`, which checks the **merged** options of **every** activity **before** any `proxyActivities` call. (2) A type-level change making `parentClosePolicy` required and non-`undefined` on `TypedChildWorkflowOptions`.

**Tech Stack:** TypeScript 6.0.3, `@temporalio/*` 1.21.1, Vitest 4.1.10, unthrown, oxlint, pnpm workspace + turbo, changesets.

## Global Constraints

Copied from `CLAUDE.md` and the spec. Every task's requirements implicitly include these.

- **No `any`.** Use `unknown` and narrow. Enforced by oxlint.
- **`.js` extensions in every import.** `./foo.js`, never `./foo` or `./foo.ts`.
- **ESM only.** All packages are `"type": "module"`.
- **Never throw** from activity/client code — return `AsyncResult` via unthrown. The **only** sanctioned exception in scope here is `ContractMisuseError` (a `ValidationError` subclass, i.e. a non-retryable `ApplicationFailure`), which already carries an `oxlint-disable-next-line unthrown/no-throw` comment at each throw site. Copy that comment verbatim on any new throw.
- **Assert effects, never call shapes.** A test that checks an option was passed to Temporal proves nothing. No new `vi.mock` of any `@temporalio/*` module — the repo's `no-sdk-mocks` guard allowlist **may only ever shrink**.
- **Catalog versions.** Never edit per-package `package.json` dependency versions.
- **R1 — per-attempt bound:** `startToCloseTimeout` or `scheduleToCloseTimeout` present in the merged options.
- **R2 — total bound:** `scheduleToCloseTimeout` present, **or** `retry.maximumAttempts` a **finite positive integer**. `Infinity`, `0`, negatives and non-integers are **not** bounds.
- **The guard runs unconditionally and on the merged result**, never per source, and never wrapped in `if (!defaultOptions)`.
- **The guard must run before every `proxyActivities` call** in `buildRawActivitiesProxy`.
- **`parentClosePolicy` must reject explicit `undefined`**, not merely omission.

### Commands you will need

```bash
# Unit tier only (this is what `pnpm --filter <pkg> test` runs — a filename
# after `--` does NOT filter):
pnpm --filter @temporal-contract/worker test

# A single unit file:
pnpm --filter @temporal-contract/worker exec vitest run --project unit src/activity-bounds.spec.ts

# In-process tier (real time-skipping Temporal server):
pnpm --filter @temporal-contract/worker exec vitest run --project integration-inprocess

# Repo-wide gates:
pnpm turbo run typecheck --force
pnpm turbo run test --force
pnpm lint
pnpm knip
```

**CRITICAL — build before any cross-package proof.** The worker resolves
`@temporal-contract/contract` to its built `dist`, **not** source (documented at
`packages/worker/vitest.config.ts:54-55`). Any change to the contract package
must be followed by `pnpm --filter @temporal-contract/contract build` before it
affects a worker test, or the test silently proves nothing.

---

## File Structure

| File                                                                       | Responsibility                                                      |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `packages/worker/src/activity-bounds.ts` (create)                          | Pure bound predicates + violation message. No Temporal runtime.     |
| `packages/worker/src/activity-bounds.spec.ts` (create)                     | Unit tests for the predicates and the message.                      |
| `packages/worker/src/internal.ts` (modify, ~118-152)                       | Replace the presence check with the merged-options bound guard.     |
| `packages/worker/src/internal.spec.ts` (modify)                            | Unit tests for each bypass path, driving `buildRawActivitiesProxy`. |
| `packages/worker/src/__tests__/activity-bounds.contract.ts` (create)       | Fixture contract whose activity is unbounded.                       |
| `packages/worker/src/__tests__/activity-bounds.workflows.ts` (create)      | Fixture workflow implementations.                                   |
| `packages/worker/src/__tests__/activity-bounds.inprocess.spec.ts` (create) | Real-server effect proof.                                           |
| `packages/worker/src/child-workflow.ts` (modify, ~43-49)                   | `parentClosePolicy` required and non-`undefined`.                   |
| `packages/worker/src/types-inference.spec.ts` (modify)                     | Type-level tests for the required field.                            |
| Fixtures + examples + docs (modify)                                        | Migration.                                                          |
| `.changeset/safe-default-option-shapes.md` (create)                        | Breaking-change record.                                             |

---

### Task 1: The bounds module

**Files:**

- Create: `packages/worker/src/activity-bounds.ts`
- Test: `packages/worker/src/activity-bounds.spec.ts`

**Interfaces:**

- Consumes: `ActivityOptions` from `@temporalio/workflow` (type-only import).
- Produces, relied on by Task 2:
  - `type BoundKind = "per-attempt" | "total"`
  - `type BoundViolation = { readonly name: string; readonly missing: readonly BoundKind[] }`
  - `function hasPerAttemptBound(options: ActivityOptions): boolean`
  - `function hasTotalBound(options: ActivityOptions): boolean`
  - `function missingBounds(options: ActivityOptions): BoundKind[]`
  - `function formatUnboundedActivitiesMessage(violations: readonly BoundViolation[]): string`

- [ ] **Step 1: Write the failing test**

Create `packages/worker/src/activity-bounds.spec.ts`:

```ts
import type { ActivityOptions } from "@temporalio/workflow";
import { describe, expect, it } from "vitest";

import {
  formatUnboundedActivitiesMessage,
  hasPerAttemptBound,
  hasTotalBound,
  missingBounds,
} from "./activity-bounds.js";

describe("hasPerAttemptBound", () => {
  it("accepts startToCloseTimeout", () => {
    expect(hasPerAttemptBound({ startToCloseTimeout: "1 minute" })).toBe(true);
  });

  it("accepts scheduleToCloseTimeout", () => {
    expect(hasPerAttemptBound({ scheduleToCloseTimeout: "1 minute" })).toBe(true);
  });

  it("rejects an options bag with neither", () => {
    expect(hasPerAttemptBound({ retry: { maximumAttempts: 3 } })).toBe(false);
  });

  it("rejects an empty options bag", () => {
    expect(hasPerAttemptBound({})).toBe(false);
  });
});

describe("hasTotalBound", () => {
  it("accepts scheduleToCloseTimeout", () => {
    expect(hasTotalBound({ scheduleToCloseTimeout: "10 minutes" })).toBe(true);
  });

  it("accepts a finite positive integer maximumAttempts", () => {
    expect(hasTotalBound({ startToCloseTimeout: "1m", retry: { maximumAttempts: 3 } })).toBe(true);
  });

  it("rejects startToCloseTimeout alone — it bounds one attempt, not the sequence", () => {
    expect(hasTotalBound({ startToCloseTimeout: "1 minute" })).toBe(false);
  });

  it("rejects Infinity — Temporal drops it because it IS the default", () => {
    expect(
      hasTotalBound({
        startToCloseTimeout: "1m",
        retry: { maximumAttempts: Number.POSITIVE_INFINITY },
      }),
    ).toBe(false);
  });

  it("rejects zero", () => {
    expect(hasTotalBound({ startToCloseTimeout: "1m", retry: { maximumAttempts: 0 } })).toBe(false);
  });

  it("rejects a negative count", () => {
    expect(hasTotalBound({ startToCloseTimeout: "1m", retry: { maximumAttempts: -1 } })).toBe(
      false,
    );
  });

  it("rejects a non-integer count", () => {
    expect(hasTotalBound({ startToCloseTimeout: "1m", retry: { maximumAttempts: 2.5 } })).toBe(
      false,
    );
  });

  it("rejects a retry block with no maximumAttempts", () => {
    expect(hasTotalBound({ startToCloseTimeout: "1m", retry: { initialInterval: "2s" } })).toBe(
      false,
    );
  });
});

describe("missingBounds", () => {
  it("reports both when the bag is empty", () => {
    expect(missingBounds({})).toEqual(["per-attempt", "total"]);
  });

  it("reports only the total bound when startToCloseTimeout is set alone", () => {
    expect(missingBounds({ startToCloseTimeout: "1 minute" })).toEqual(["total"]);
  });

  it("reports only the per-attempt bound when maximumAttempts is set alone", () => {
    expect(missingBounds({ retry: { maximumAttempts: 3 } })).toEqual(["per-attempt"]);
  });

  it("reports nothing when scheduleToCloseTimeout satisfies both", () => {
    const options: ActivityOptions = { scheduleToCloseTimeout: "10 minutes" };
    expect(missingBounds(options)).toEqual([]);
  });
});

describe("formatUnboundedActivitiesMessage", () => {
  it("names every offending activity and the bound it lacks", () => {
    const message = formatUnboundedActivitiesMessage([
      { name: "chargeCard", missing: ["per-attempt", "total"] },
      { name: "sendReceipt", missing: ["total"] },
    ]);

    expect(message).toContain("chargeCard");
    expect(message).toContain("sendReceipt");
    // The remedy for each rule must be stated, not just the rule name.
    expect(message).toContain("startToCloseTimeout");
    expect(message).toContain("retry.maximumAttempts");
    // The shallow-merge footgun is the non-obvious cause; the message must say so.
    expect(message).toContain("shallow");
  });

  it("does not mention a bound the activity actually has", () => {
    const message = formatUnboundedActivitiesMessage([{ name: "sendReceipt", missing: ["total"] }]);
    expect(message).not.toContain("per-attempt bound");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @temporal-contract/worker exec vitest run --project unit src/activity-bounds.spec.ts`

Expected: FAIL — `Failed to resolve import "./activity-bounds.js"`.

- [ ] **Step 3: Write the implementation**

Create `packages/worker/src/activity-bounds.ts`:

```ts
/**
 * Bound rules for activity options, split out of `internal.ts` so they are
 * unit-testable without a workflow sandbox or a Temporal server.
 *
 * Two independent bounds must hold for every reachable activity:
 *
 * - **per-attempt** — how long ONE attempt may run.
 * - **total** — how long the whole retry sequence may run.
 *
 * They are genuinely independent. `startToCloseTimeout` caps a single attempt
 * and says nothing about the sequence, while `RetryPolicy.maximumAttempts`
 * defaults to `Infinity` (`@temporalio/common/lib/retry-policy.d.ts:21-26`).
 * An activity with only `startToCloseTimeout` therefore retries a
 * non-transient failure roughly every 100 seconds, forever.
 */
import type { ActivityOptions } from "@temporalio/workflow";

/** Which of the two bounds an activity is missing. */
export type BoundKind = "per-attempt" | "total";

/** One activity that fails the bound rules, and which bounds it lacks. */
export type BoundViolation = {
  readonly name: string;
  readonly missing: readonly BoundKind[];
};

/**
 * True when the options cap a single attempt. `scheduleToCloseTimeout` counts:
 * it caps the whole sequence, so it necessarily caps one attempt.
 */
export function hasPerAttemptBound(options: ActivityOptions): boolean {
  return options.startToCloseTimeout !== undefined || options.scheduleToCloseTimeout !== undefined;
}

/**
 * True when the options cap the whole retry sequence.
 *
 * `maximumAttempts` is a bound only when it is a finite positive integer:
 * Temporal deletes the field when it is `Infinity` because that IS the default
 * (`retry-policy.js:15-18`), and rejects `<= 0` and non-integers with a
 * `ValueError` in `compileRetryPolicy`. Stating the rule positively means an
 * unbounded value produces this library's message, while a genuinely invalid
 * value still reaches Temporal's own validation.
 */
export function hasTotalBound(options: ActivityOptions): boolean {
  if (options.scheduleToCloseTimeout !== undefined) return true;
  const maximumAttempts = options.retry?.maximumAttempts;
  return (
    typeof maximumAttempts === "number" && Number.isInteger(maximumAttempts) && maximumAttempts > 0
  );
}

/** The bounds these options lack, in a stable order. Empty means compliant. */
export function missingBounds(options: ActivityOptions): BoundKind[] {
  const missing: BoundKind[] = [];
  if (!hasPerAttemptBound(options)) missing.push("per-attempt");
  if (!hasTotalBound(options)) missing.push("total");
  return missing;
}

const REMEDY: Record<BoundKind, string> = {
  "per-attempt":
    "missing a per-attempt bound (set `startToCloseTimeout` or `scheduleToCloseTimeout`)",
  total:
    "missing a total bound (set `scheduleToCloseTimeout`, or a finite positive `retry.maximumAttempts`)",
};

/**
 * The `ContractMisuseError` message. Names every offender and the remedy for
 * each rule it broke, then explains the non-obvious cause: because the three
 * option layers shallow-merge, a later layer's `retry` replaces an earlier
 * layer's entirely, so two individually-bounded layers can merge to something
 * unbounded.
 */
export function formatUnboundedActivitiesMessage(violations: readonly BoundViolation[]): string {
  const lines = violations.map(
    ({ name, missing }) => `  - ${name}: ${missing.map((kind) => REMEDY[kind]).join(", ")}`,
  );
  return (
    `declareWorkflow: every reachable activity needs a per-attempt bound and a total bound, ` +
    `so a failing activity cannot retry forever. These do not:\n${lines.join("\n")}\n` +
    `Options are merged from \`declareWorkflow\`'s \`activityOptions\`, the contract's ` +
    `\`defineActivity({ activityOptions })\`, and \`activityOptionsByName\`. That merge is ` +
    `shallow, so a later layer's \`retry\` replaces an earlier layer's entirely — check the ` +
    `merged result, not each layer.`
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @temporal-contract/worker exec vitest run --project unit src/activity-bounds.spec.ts`

Expected: PASS, 20 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/activity-bounds.ts packages/worker/src/activity-bounds.spec.ts
git commit -m "feat(worker): add activity bound rules as a pure module"
```

---

### Task 2: Wire the guard into `buildRawActivitiesProxy`

**Files:**

- Modify: `packages/worker/src/internal.ts:118-152`
- Test: `packages/worker/src/internal.spec.ts`

**Interfaces:**

- Consumes from Task 1: `missingBounds`, `formatUnboundedActivitiesMessage`, `type BoundViolation`.
- Produces: no new exports. `buildRawActivitiesProxy`'s signature is unchanged:
  `buildRawActivitiesProxy(workflowActivities, contractActivities, defaultOptions, overrides): Record<string, ActivityFn>`

**Context the implementer needs:**

The existing check at `internal.ts:124-145` tests presence of keys **per source** and is wrapped in `if (!defaultOptions)`. Three inputs defeat it: a `retry`-only contract bag, a `retry`-only override, and **any** truthy `activityOptions` on `declareWorkflow` (which skips the block entirely). Delete it and replace with the code below.

- [ ] **Step 1: Write the failing tests**

Append to `packages/worker/src/internal.spec.ts` (keep the two existing tests; the first one still passes because an empty bag violates both rules):

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @temporal-contract/worker exec vitest run --project unit src/internal.spec.ts`

Expected: FAIL. The four rejection tests fail because no error is thrown (or a `TypeError` escapes instead of a `ContractMisuseError`); the "does not construct a default proxy" test fails with Temporal's `TypeError: Required either scheduleToCloseTimeout or startToCloseTimeout`.

- [ ] **Step 3: Replace the guard**

In `packages/worker/src/internal.ts`, add to the imports:

```ts
import {
  type BoundViolation,
  formatUnboundedActivitiesMessage,
  missingBounds,
} from "./activity-bounds.js";
```

Delete lines 118-145 (the comment block plus the whole `if (!defaultOptions) { ... }` block) and put this in its place:

```ts
// Every reachable activity must carry BOTH bounds in its MERGED options: a
// per-attempt bound and a total bound. See `activity-bounds.ts` for why the
// two are independent.
//
// Checked on the MERGE, not per source. The layers shallow-merge, so a
// contract-level `retry: { initialInterval: "2s" }` replaces a workflow-wide
// `retry: { maximumAttempts: 3 }` wholesale and silently drops the bound —
// both layers look bounded in isolation.
//
// Checked UNCONDITIONALLY. The previous version ran only when
// `defaultOptions` was absent, so any truthy `activityOptions` on
// `declareWorkflow` skipped it for every activity.
//
// This must run BEFORE the `proxyActivities` calls below. Temporal validates
// options at proxy CONSTRUCTION (`@temporalio/workflow` `lib/workflow.js:496-502`)
// and throws a plain `TypeError`, which inside the sandbox is retried as a
// Workflow Task failure forever (D3): the workflow hangs rather than failing.
const violations: BoundViolation[] = [];
for (const [name, definition] of Object.entries(allDefinitions)) {
  // Must mirror the merge at the bottom of this function EXACTLY, including
  // its shallowness — a deep merge here would report bounds the running
  // workflow will not actually have.
  const merged: ActivityOptions = {
    ...defaultOptions,
    ...(definition.activityOptions as ActivityOptions | undefined),
    ...overrides?.[name],
  };
  const missing = missingBounds(merged);
  if (missing.length > 0) {
    violations.push({ name, missing });
  }
}
if (violations.length > 0) {
  // ContractMisuseError (a non-retryable ApplicationFailure), not a plain
  // Error: this runs inside the workflow sandbox, where a plain Error would
  // be retried as a Workflow Task failure forever (D3).
  // oxlint-disable-next-line unthrown/no-throw -- sanctioned ContractMisuseError model: declaration-time fail-fast as a non-retryable ApplicationFailure (CLAUDE.md rule 2 exception)
  throw new ContractMisuseError(formatUnboundedActivitiesMessage(violations));
}
```

Then replace the `defaultProxy` construction (was lines 147-152) with:

```ts
// Build the workflow-wide proxy only if some activity actually relies on it.
// When every activity carries its own options, `defaultOptions` is never the
// effective options for anything, and the loop above never validated it —
// constructing a proxy from an unbounded default would throw Temporal's
// plain `TypeError` (→ workflow-task stall) for options no activity would
// ever have used. The same reasoning covers the no-activities case.
const needsDefaultProxy = Object.entries(allDefinitions).some(([name, definition]) => {
  const contractDefaults = definition.activityOptions;
  const override = overrides?.[name];
  const hasContractDefaults = contractDefaults && Object.keys(contractDefaults).length > 0;
  const hasOverride = override && Object.keys(override).length > 0;
  return !hasContractDefaults && !hasOverride;
});
const defaultProxy =
  defaultOptions && needsDefaultProxy
    ? proxyActivities<Record<string, ActivityFn>>(defaultOptions)
    : undefined;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @temporal-contract/worker exec vitest run --project unit src/internal.spec.ts`

Expected: PASS, all tests including the two pre-existing ones.

- [ ] **Step 5: Run the whole worker unit tier**

Run: `pnpm --filter @temporal-contract/worker test`

Expected: PASS. If any pre-existing test now fails, it is one of two things — **report which, do not silently adjust the guard**:

1. A fixture that genuinely has an unbounded activity. Fix the fixture (add a bound), not the guard.
2. A test relying on `defaultProxy` serving a name that is not a declared activity. The conditional `defaultProxy` changes that fallback. Report it; the answer is likely to keep the conditional and fix the test, but the controller decides.

- [ ] **Step 6: Commit**

```bash
git add packages/worker/src/internal.ts packages/worker/src/internal.spec.ts
git commit -m "fix(worker)!: enforce activity bounds on merged options, unconditionally"
```

---

### Task 3: Prove the guard is falsifiable (mutation matrix)

**Files:**

- Modify: none (verification task). Record results in the task report.

**Interfaces:**

- Consumes: Tasks 1 and 2 as committed.
- Produces: a mutation matrix in the report; no code.

**Why this task exists:** the defect being fixed _is_ a guard that passes vacuously. A green suite proves nothing on its own — it was green before this plan started, with all three bypass paths open. Each mutation below must break a **distinct, non-empty** set of tests. If any mutation leaves the suite green, the corresponding rule is untested and you must add a test that fails under it.

- [ ] **Step 1: Record the baseline**

Run: `pnpm --filter @temporal-contract/worker test`
Record the exact pass count. Confirm the tree is clean with `git status --porcelain` first — a dirty tree invalidates every result below.

- [ ] **Step 2: Mutation (a) — drop R1**

In `activity-bounds.ts`, change `hasPerAttemptBound` to `return true;`.

Run: `pnpm --filter @temporal-contract/worker test`
Expected: FAIL. Record the exact failing test names.
Restore with `git checkout -- packages/worker/src/activity-bounds.ts`.

- [ ] **Step 3: Mutation (b) — drop R2**

In `activity-bounds.ts`, change `hasTotalBound` to `return true;`.

Run: `pnpm --filter @temporal-contract/worker test`
Expected: FAIL, on a **different** set from (a). Record the names.
Restore with `git checkout -- packages/worker/src/activity-bounds.ts`.

- [ ] **Step 4: Mutation (c) — restore the `!defaultOptions` bypass**

In `internal.ts`, wrap the violations loop and its throw in `if (!defaultOptions) { ... }`.

Run: `pnpm --filter @temporal-contract/worker test`
Expected: FAIL, specifically including `runs even when declareWorkflow supplies activityOptions — the old bypass`.
Restore with `git checkout -- packages/worker/src/internal.ts`.

- [ ] **Step 5: Mutation (d) — make the guard's merge deep**

In `internal.ts`, change the guard's `merged` computation to deep-merge `retry`:

```ts
const merged: ActivityOptions = {
  ...defaultOptions,
  ...(definition.activityOptions as ActivityOptions | undefined),
  ...overrides?.[name],
  retry: {
    ...defaultOptions?.retry,
    ...(definition.activityOptions?.retry as ActivityOptions["retry"] | undefined),
    ...overrides?.[name]?.retry,
  },
};
```

Run: `pnpm --filter @temporal-contract/worker test`
Expected: FAIL, specifically `rejects an override that drops the bound via the shallow retry merge`. This proves the test actually depends on the guard mirroring the real merge's shallowness.
Restore with `git checkout -- packages/worker/src/internal.ts`.

- [ ] **Step 6: Mutation (e) — unconditional default proxy**

In `internal.ts`, change the `defaultProxy` line back to `defaultOptions ? proxyActivities(...) : undefined`.

Run: `pnpm --filter @temporal-contract/worker test`
Expected: FAIL on `does not construct a default proxy no activity relies on`.
Restore with `git checkout -- packages/worker/src/internal.ts`.

- [ ] **Step 7: Confirm the tree is clean and the suite is green**

```bash
git status --porcelain   # must be empty
pnpm --filter @temporal-contract/worker test
```

Report the full matrix: five mutations, the failing test names for each, and confirmation that the five sets are distinct and non-empty. **If two mutations break the identical set, say so** — it means one rule is not independently tested.

- [ ] **Step 8: Commit**

Nothing to commit. Report only.

---

### Task 4: Real-server effect proof

**Files:**

- Create: `packages/worker/src/__tests__/activity-bounds.contract.ts`
- Create: `packages/worker/src/__tests__/activity-bounds.workflows.ts`
- Create: `packages/worker/src/__tests__/activity-bounds.inprocess.spec.ts`

**Interfaces:**

- Consumes: Task 2's guard, `@temporal-contract/testing`'s `testRig`, `bundleFor`, `fixturePath`, `nextTaskQueueId`, `withTaskQueue`.
- Produces: no exports consumed by later tasks.

**Context:** unit tests prove the function throws. This proves the **effect**: a workflow whose activity is unbounded **fails cleanly** with a `ContractMisuseError` instead of hanging in a workflow-task retry loop. Model the file on `packages/worker/src/__tests__/idempotency.inprocess.spec.ts`. **No `vi.mock`** — the `no-sdk-mocks` allowlist may only shrink.

- [ ] **Step 1: Write the fixture contract**

Create `packages/worker/src/__tests__/activity-bounds.contract.ts`:

```ts
import { defineActivity, defineContract, defineWorkflow } from "@temporal-contract/contract";
import { z } from "zod";

/**
 * The activity declares `retry` but no timeout — non-empty, so the OLD
 * presence-based guard considered it covered. Its merged options have no
 * per-attempt bound, so the new guard rejects it at declaration time.
 */
const unboundedActivity = defineActivity({
  input: z.object({}),
  output: z.object({ done: z.boolean() }),
  activityOptions: { retry: { maximumAttempts: 3 } },
});

const boundedActivity = defineActivity({
  input: z.object({}),
  output: z.object({ done: z.boolean() }),
  activityOptions: { startToCloseTimeout: "10 seconds", retry: { maximumAttempts: 3 } },
});

export const activityBoundsContract = defineContract({
  taskQueue: "activity-bounds",
  workflows: {
    unboundedWorkflow: defineWorkflow({
      input: z.object({}),
      output: z.object({ done: z.boolean() }),
      idempotency: "allow-duplicate",
      activities: { unboundedActivity },
    }),
    boundedWorkflow: defineWorkflow({
      input: z.object({}),
      output: z.object({ done: z.boolean() }),
      idempotency: "allow-duplicate",
      activities: { boundedActivity },
    }),
  },
});
```

- [ ] **Step 2: Write the fixture workflows**

Create `packages/worker/src/__tests__/activity-bounds.workflows.ts`:

```ts
import { declareWorkflow } from "@temporal-contract/worker";

import { activityBoundsContract } from "./activity-bounds.contract.js";

export const unboundedWorkflow = declareWorkflow(activityBoundsContract, "unboundedWorkflow", {
  implementation: async (context) => {
    const result = await context.activities.unboundedActivity({});
    return { done: result.done };
  },
});

export const boundedWorkflow = declareWorkflow(activityBoundsContract, "boundedWorkflow", {
  implementation: async (context) => {
    const result = await context.activities.boundedActivity({});
    return { done: result.done };
  },
});
```

**If `declareWorkflow`'s exact option shape differs** (e.g. `activityOptions` is also needed), read `packages/worker/src/__tests__/idempotency.workflows.ts` and match its shape — that file is known-good on this branch.

- [ ] **Step 3: Write the failing effect test**

Create `packages/worker/src/__tests__/activity-bounds.inprocess.spec.ts`:

```ts
import { WORKFLOW_FAILED_ERROR_TAG } from "@temporal-contract/client";
import { testRig } from "@temporal-contract/testing/test-rig";
import { it } from "@temporal-contract/testing/time-skipping";
import {
  bundleFor,
  fixturePath,
  nextTaskQueueId,
  withTaskQueue,
} from "@temporal-contract/testing/workflow-bundle";
import { describe, expect } from "vitest";

import { activityBoundsContract } from "./activity-bounds.contract.js";

const WORKFLOW_EXECUTION_TIMEOUT = "30 seconds";

describe("unbounded activities fail the workflow instead of stalling it", () => {
  it("fails with ContractMisuseError rather than hanging", async ({ testEnv }) => {
    const id = nextTaskQueueId("activity-bounds-unbounded");
    const contract = withTaskQueue(activityBoundsContract, id);
    const bundle = await bundleFor(fixturePath(import.meta.url, "activity-bounds.workflows"));
    const { worker, client } = await testRig(testEnv, { contract, bundle });

    const result = await worker.raw.runUntil(
      client.executeWorkflow("unboundedWorkflow", {
        workflowId: id,
        args: {},
        workflowExecutionTimeout: WORKFLOW_EXECUTION_TIMEOUT,
      }),
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;

    // Discriminate on IDENTITY, not merely `isErr`. A workflow stuck in a
    // task-retry loop also produces an Err once the execution timeout fires,
    // so `isErr()` alone passes in BOTH the fixed and the broken world — that
    // exact false green shipped earlier in this workstream.
    expect(result.error._tag).toBe(WORKFLOW_FAILED_ERROR_TAG);
    const message = JSON.stringify(result.error);
    expect(message).toContain("ContractMisuseError");
    expect(message).toContain("unboundedActivity");
    expect(message).toContain("per-attempt");
    // The stall signature: a timed-out execution, not a clean failure.
    expect(message).not.toContain("timed out");
  });

  it("a bounded activity still runs to completion", async ({ testEnv }) => {
    const id = nextTaskQueueId("activity-bounds-bounded");
    const contract = withTaskQueue(activityBoundsContract, id);
    const bundle = await bundleFor(fixturePath(import.meta.url, "activity-bounds.workflows"));
    const { worker, client } = await testRig(testEnv, {
      contract,
      bundle,
      activities: { boundedActivity: async () => ({ done: true }) },
    });

    const result = await worker.raw.runUntil(
      client.executeWorkflow("boundedWorkflow", {
        workflowId: id,
        args: {},
        workflowExecutionTimeout: WORKFLOW_EXECUTION_TIMEOUT,
      }),
    );

    expect(result.isOk()).toBe(true);
  });
});
```

**Shape caveat, read before running:** the exact `testRig` options, the error-tag constant name, and how activities are registered may differ. Read `packages/worker/src/__tests__/idempotency.inprocess.spec.ts` and `child-idempotency.inprocess.spec.ts` and match them. Adjust the assertions' **mechanics** freely; do **not** weaken the assertions themselves — the identity check and the "not a timeout" check are the point of the test.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @temporal-contract/worker exec vitest run --project integration-inprocess src/__tests__/activity-bounds.inprocess.spec.ts`

Expected: PASS, 2 tests.

- [ ] **Step 5: Prove the test can fail**

Temporarily change `hasPerAttemptBound` in `activity-bounds.ts` to `return true;` and re-run the file.

Expected: the first test FAILS. Record how it fails — if it fails by **timing out** rather than by a wrong error identity, that is itself the finding to report: it means the broken world stalls, which is exactly the behavior being fixed, and the assertion correctly distinguishes them.

Restore with `git checkout -- packages/worker/src/activity-bounds.ts` and re-run to confirm green.

- [ ] **Step 6: Confirm the SDK-mock guard still passes**

Run: `pnpm --filter @temporal-contract/testing test`

Expected: PASS. The `no-sdk-mocks` guard lives in the **testing** package, not the worker — a new `vi.mock` in a worker test is invisible to the worker's own suite. This exact asymmetry hid a regression earlier in this workstream.

- [ ] **Step 7: Commit**

```bash
git add packages/worker/src/__tests__/activity-bounds.*
git commit -m "test(worker): prove unbounded activities fail cleanly on the real server"
```

---

### Task 5: Require `parentClosePolicy` on child calls

**Files:**

- Modify: `packages/worker/src/child-workflow.ts:36-49`
- Test: `packages/worker/src/types-inference.spec.ts`

**Interfaces:**

- Consumes: `ChildWorkflowOptions`, and now also `ParentClosePolicy`, both from `@temporalio/workflow`.
- Produces, relied on by Task 6:
  `TypedChildWorkflowOptions<TChildContract, TChildWorkflowName>` now requires
  `parentClosePolicy: Exclude<ParentClosePolicy, undefined>`, i.e.
  `"TERMINATE" | "ABANDON" | "REQUEST_CANCEL"`.

**The trap — read this before writing the type.** The SDK declares:

```ts
export type ParentClosePolicy = (typeof ParentClosePolicy)[keyof typeof ParentClosePolicy];
```

and that object includes `PARENT_CLOSE_POLICY_UNSPECIFIED: undefined`
(`@temporalio/workflow/lib/interfaces.d.ts:399-439`). So the union **contains
`undefined`**, and a bare required `parentClosePolicy: ParentClosePolicy` still
accepts `undefined` — a required field that requires nothing. The `Exclude` is
the whole component.

- [ ] **Step 1: Write the failing type tests**

That file already has the fixture you need: `inferenceContract`
(`types-inference.spec.ts:114-118`) with an `otherWorkflow` whose input is
`z.object({ batchId: z.string() })`, and it already imports
`type TypedChildWorkflowHandle` from `./child-workflow.js` at line 32. Add
`TypedChildWorkflowOptions` to that same import:

```ts
import type { TypedChildWorkflowHandle, TypedChildWorkflowOptions } from "./child-workflow.js";
```

Then append:

```ts
describe("TypedChildWorkflowOptions requires an explicit parentClosePolicy", () => {
  type ChildOptions = TypedChildWorkflowOptions<typeof inferenceContract, "otherWorkflow">;

  it("accepts each of the three real policies", () => {
    const terminate: ChildOptions["parentClosePolicy"] = "TERMINATE";
    const abandon: ChildOptions["parentClosePolicy"] = "ABANDON";
    const requestCancel: ChildOptions["parentClosePolicy"] = "REQUEST_CANCEL";
    expect([terminate, abandon, requestCancel]).toHaveLength(3);
  });

  it("rejects omission", () => {
    // @ts-expect-error parentClosePolicy is required
    const options: ChildOptions = { workflowId: "child-1", args: { batchId: "B-1" } };
    expect(options).toBeDefined();
  });

  it("rejects an explicit undefined", () => {
    // This is the test that fails if `Exclude<..., undefined>` is dropped: the
    // SDK's ParentClosePolicy union CONTAINS undefined, so a bare required
    // field would accept this and the component would be a silent no-op.
    // @ts-expect-error parentClosePolicy may not be undefined
    const options: ChildOptions = {
      workflowId: "child-1",
      args: { batchId: "B-1" },
      parentClosePolicy: undefined,
    };
    expect(options).toBeDefined();
  });
});
```

Note that the existing `startChildWorkflow` call at `types-inference.spec.ts:197`
will itself stop compiling once the field is required — that is expected, and it
is one of Task 6's call sites.

- [ ] **Step 2: Run typecheck to verify it fails**

Run: `pnpm --filter @temporal-contract/worker exec tsc --noEmit`

Expected: FAIL — the two `@ts-expect-error` directives report _"Unused '@ts-expect-error' directive"_, because the field is currently optional and `undefined` is currently allowed. That unused-directive error **is** the failing state; it is what proves the tests are meaningful.

- [ ] **Step 3: Make the field required**

In `packages/worker/src/child-workflow.ts`, add `ParentClosePolicy` to the existing `@temporalio/workflow` type imports:

```ts
import {
  type ChildWorkflowHandle,
  type ChildWorkflowOptions,
  executeChild,
  type ParentClosePolicy,
  startChild,
  type Workflow,
} from "@temporalio/workflow";
```

Then replace the type (currently at lines 43-49) and extend its doc comment:

```ts
/**
 * Options for starting a child workflow. `taskQueue` and `args` come from
 * the contract, which also supplies a default `workflowIdReusePolicy`
 * derived from the target workflow's declared `idempotency` mode; everything
 * else — including an explicit `workflowIdReusePolicy` here, which overrides
 * that default — is forwarded to Temporal's `startChild` / `executeChild`.
 *
 * `parentClosePolicy` is **required**. Temporal's default is `TERMINATE`: when
 * the parent closes, the child is killed — mid-payment included. That default
 * is fine when chosen and dangerous when inherited, so it must be stated.
 * `TERMINATE` remains available; it simply has to be written down.
 *
 * The `Exclude` is load-bearing. The SDK's `ParentClosePolicy` union contains
 * `undefined` (via the deprecated `PARENT_CLOSE_POLICY_UNSPECIFIED` member), so
 * a bare required field would still accept `undefined` and require nothing.
 */
export type TypedChildWorkflowOptions<
  TChildContract extends ContractDefinition,
  TChildWorkflowName extends keyof TChildContract["workflows"] & string,
> = Omit<ChildWorkflowOptions, "taskQueue" | "args" | "parentClosePolicy"> & {
  args: ClientInferInput<TChildContract["workflows"][TChildWorkflowName]>;
  parentClosePolicy: Exclude<ParentClosePolicy, undefined>;
};
```

- [ ] **Step 4: Run typecheck to verify the tests now pass**

Run: `pnpm --filter @temporal-contract/worker exec tsc --noEmit`

Expected: the two unused-directive errors are gone. Remaining errors will be call sites missing the field — those are Task 6's work. **Record the full list of failing call sites now** and put it in your report; Task 6's implementer uses it as the worklist.

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/child-workflow.ts packages/worker/src/types-inference.spec.ts
git commit -m "feat(worker)!: require an explicit parentClosePolicy on child workflow calls"
```

---

### Task 6: Migrate every call site and fixture

**Files:**

- Modify: every file the typechecker and the new guard reject. Known starting set — the typechecker is authoritative, this list is not:
  - `packages/worker/src/workflow.ts` (4 child call sites, in doc comments and/or code)
  - `packages/worker/src/__tests__/child-wire.workflows.ts` (3)
  - `packages/worker/src/__tests__/child-idempotency.workflows.ts` (2)
  - `packages/worker/src/__tests__/test.workflows.ts` (1)
  - `packages/worker/src/types-inference.spec.ts` (1)
  - plus any contract/worker fixture whose activities lack a bound

**Interfaces:**

- Consumes: Task 5's required `parentClosePolicy`, Task 2's bound guard.
- Produces: a repo-wide green typecheck and test run.

**Method — use the tools as the worklist, not grep.** Run the typechecker and the test suites; fix what they report; repeat until clean. Grep misses call sites behind type aliases and casts, and a previous migration in this workstream missed four definitions hidden behind a pre-existing cast.

- [ ] **Step 1: Get the full list**

```bash
pnpm turbo run typecheck --force 2>&1 | tee /tmp/typecheck.log
pnpm turbo run test --force 2>&1 | tee /tmp/test.log
pnpm --filter @temporal-contract/worker exec vitest run --project integration-inprocess 2>&1 | tee /tmp/inprocess.log
```

- [ ] **Step 2: Add `parentClosePolicy` to each child call site**

For each site, choose the policy deliberately and **write a one-line comment saying why** when the choice is not obvious:

- `"TERMINATE"` — preserves today's behavior exactly. Correct for a child that is pure computation with no side effect to unwind.
- `"REQUEST_CANCEL"` — the child needs to compensate before it stops.
- `"ABANDON"` — fire-and-forget work that should outlive its parent.

For **test fixtures whose assertions do not concern parent-close behavior**, use `"TERMINATE"`: it is Temporal's prior default, so the fixture's behavior is unchanged and the test keeps testing what it tested before.

Example:

```ts
const handle = await context.startChildWorkflow(childContract, "childWorkflow", {
  workflowId: `child-${id}`,
  args: { value: 1 },
  // Preserves the pre-8.0.0 default; this child has no state to unwind.
  parentClosePolicy: "TERMINATE",
});
```

- [ ] **Step 3: Add bounds to every activity the guard rejects**

For each rejected activity, add the missing bound to whichever layer is the right home:

- The **contract's** `defineActivity({ activityOptions })` when the bound is a property of the operation and should be shared by every worker.
- `declareWorkflow`'s `activityOptions` when it is a workflow-wide default.
- `activityOptionsByName` for a genuine per-workflow exception.

For fixtures with no opinion, `{ startToCloseTimeout: "10 seconds", retry: { maximumAttempts: 3 } }` is a reasonable pair. **Do not** reach for `scheduleToCloseTimeout` merely because it satisfies both rules in one field — pick what the activity actually needs.

**Critical:** a fixture whose test asserts timeout or retry behavior must keep asserting it. If you change a bound and a test still passes, check whether that test was ever really exercising the behavior — say so in your report if it was not.

- [ ] **Step 4: Re-run everything until clean**

```bash
pnpm turbo run typecheck --force
pnpm turbo run test --force
pnpm --filter @temporal-contract/worker exec vitest run --project integration-inprocess
pnpm --filter @temporal-contract/testing test
pnpm lint
pnpm knip
```

Expected: all green.

- [ ] **Step 5: Report the counts**

In your report, state exactly: how many child call sites you migrated and which policy each got; how many activities gained a bound and at which layer; and any test whose behavior changed. Do **not** round or estimate — count.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor!: state parentClosePolicy and activity bounds at every call site"
```

---

### Task 7: Documentation and changeset

**Files:**

- Modify: `docs/how-to/run-child-workflows.md`, `docs/reference/worker-surface.md`, `docs/how-to/upgrade-to-v8.md`, `docs/how-to/handle-cancellation.md`, `packages/worker/README.md`, `packages/worker/src/workflow.ts` (JSDoc for `activityOptions` and the child helpers), `.agents/rules/handlers.md`
- Create: `.changeset/safe-default-option-shapes.md`

**Interfaces:**

- Consumes: Tasks 2 and 5 as shipped.
- Produces: no code.

**The accuracy bar — this branch's predecessor failed it five times.** Every factual claim must be checked against the code, and **every TypeScript snippet must be compiled**, not read. Snippets verified by reading shipped broken four rounds running on the previous branch, and a snippet that compiled while contradicting its own comment shipped even after that.

- [ ] **Step 1: Update the child-workflow docs**

`docs/how-to/run-child-workflows.md` currently says (around line 198):

```
  // Reuse behaviour when the id already exists. The child's contract already
  // supplies this from its `idempotency` mode — set it here only to override
  // that default for this one call.
  workflowIdReusePolicy: "ALLOW_DUPLICATE_FAILED_ONLY",
```

Add `parentClosePolicy` to that same example as a required field, and update the prose below it — which currently reads _"`parentClosePolicy` is the one to think about: the default (`TERMINATE`) kills children when the parent closes"_ — since there is no longer a default to inherit.

- [ ] **Step 2: Document the bound rules**

Add a section to `docs/reference/worker-surface.md` stating both rules exactly, with the three merge layers and the shallow-merge consequence. Include the `maximumAttempts` edge cases: `Infinity` is not a bound (Temporal drops it as the default), and `<= 0` / non-integers are rejected by Temporal itself.

Do **not** claim the guard prevents "Temporal's generic error" — state what it actually prevents: a plain `TypeError` from `proxyActivities` at workflow start, which inside the sandbox becomes an indefinite workflow-task retry loop.

- [ ] **Step 3: Write the upgrade guide section**

Add a section to `docs/how-to/upgrade-to-v8.md` covering both breaking changes: what fails, the exact error text, and how to fix each. State plainly that `"TERMINATE"` reproduces the previous behavior for `parentClosePolicy`.

- [ ] **Step 4: Compile every snippet you touched**

Build a scratch project **outside** the repo, symlink the built packages into it, and compile with the repo's own `tsc`. Build first — consumers resolve `@temporal-contract/*` to `dist`, not source:

```bash
pnpm turbo run build
```

Then, before trusting a green result, **prove the harness can fail**: introduce a deliberate error into one snippet (e.g. `parentClosePolicy: "TERMINAT"`) and confirm `tsc` reports it. A harness that cannot fail cannot verify. Report the typo you used and the error it produced.

- [ ] **Step 5: Write the changeset**

Create `.changeset/safe-default-option-shapes.md`:

```markdown
---
"@temporal-contract/contract": major
"@temporal-contract/client": major
"@temporal-contract/worker": major
"@temporal-contract/testing": major
---

Two safety requirements are now enforced instead of assumed.

**Every activity needs a per-attempt bound and a total bound.** ...
```

Complete the body: both rules, the exact error message shape, the migration for each, and the fact that `"TERMINATE"` preserves prior parent-close behavior. Include only packages that actually changed — verify with `git diff --stat main..HEAD -- packages/` and drop any package with no source change.

- [ ] **Step 6: Run every gate**

```bash
pnpm turbo run typecheck --force
pnpm turbo run test --force
pnpm --filter @temporal-contract/worker exec vitest run --project integration-inprocess
pnpm --filter @temporal-contract/testing test
pnpm lint
pnpm knip
pnpm changeset status
```

Expected: all green, and `changeset status` lists the new changeset.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "docs: document activity bounds and the required parentClosePolicy"
```

---

## Self-Review

**Spec coverage.** Every spec section maps to a task: the merged-options guard and all three bypass paths → Tasks 1-2; the `defaultProxy` sub-case → Task 2 Step 3; falsifiability and the mutation matrix → Task 3 (which adds mutation (e) beyond the spec's four, for the conditional default proxy); the real-server effect proof with identity discrimination → Task 4; `parentClosePolicy` with the load-bearing `Exclude` and both `@ts-expect-error` cases → Task 5; migration → Task 6; docs and changeset → Task 7. Success criteria 1-6 are covered by Tasks 2, 3, 2, 5, 6, 7 respectively.

**Type consistency.** `BoundKind`, `BoundViolation`, `hasPerAttemptBound`, `hasTotalBound`, `missingBounds`, and `formatUnboundedActivitiesMessage` are defined in Task 1 and used under those exact names in Tasks 2 and 3. `buildRawActivitiesProxy`'s signature is unchanged throughout. `TypedChildWorkflowOptions` is defined in Task 5 and consumed in Task 6.

**Fixed during self-review.** Task 5 originally referenced an invented fixture (`testContract` / `"childWorkflow"`); it now uses the real `inferenceContract` / `"otherWorkflow"` with its real `{ batchId: string }` input, verified against `types-inference.spec.ts:108-118`, and names the exact import line to extend. `WORKFLOW_FAILED_ERROR_TAG` is confirmed exported from `@temporal-contract/client` (`index.ts:76`).

**Known softness, flagged deliberately rather than papered over.** Task 4's fixture shapes (`testRig` options, activity registration, the `declareWorkflow` option shape) are written from the pattern in `idempotency.inprocess.spec.ts` but were not compiled while writing this plan. Task 4 Step 3 therefore instructs the implementer to read the known-good neighbours and adapt the **mechanics** while keeping the **assertions** intact. That is the one place an implementer should expect to adjust rather than transcribe — and the one place a reviewer should check that the adjustment did not quietly weaken an assertion.
