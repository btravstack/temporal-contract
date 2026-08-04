import type {
  AnyWorkflowDefinition,
  QueryDefinition,
  SignalDefinition,
  UpdateDefinition,
} from "@temporal-contract/contract";
/**
 * Runtime coverage for the six `ContractMisuseError` fail-fast paths in
 * `bindSignalHandler` / `bindQueryHandler` / `bindUpdateHandler`
 * (`handlers.ts:195-207`, `246-258`, `348-360`) — the "workflow declares no
 * {signals,queries,updates} block" guard and the "name not found in the
 * declared block" guard, for each of the three handler kinds.
 *
 * All six are reachable without a Temporal workflow environment or an SDK
 * mock, for the same reason `internal.spec.ts`'s two `ContractMisuseError`
 * guards are: every one of these throws fires *before* the function reaches
 * `defineSignal`/`defineQuery`/`defineUpdate` + `setHandler` — the calls that
 * actually need a running workflow's activator. `@temporalio/workflow` is
 * still imported transitively (through `../handlers.js`), but importing the
 * module is not the same as invoking those calls, and this file never gets
 * far enough to invoke them.
 *
 * Each assertion checks the exact message, not just the `ContractMisuseError`
 * class — six near-identical guards sharing one error class means a test
 * that only checked `toThrow(ContractMisuseError)` could pass even if the
 * production code accidentally swapped two of the six messages (e.g. the
 * query "not found" guard firing the update "not found" wording). The exact
 * strings below are copied verbatim from `handlers.ts`.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { ContractMisuseError } from "./errors.js";
import { bindQueryHandler, bindSignalHandler, bindUpdateHandler } from "./handlers.js";

const baseDefinition = (): AnyWorkflowDefinition =>
  ({
    input: z.object({}),
    output: z.object({}),
    idempotency: "allow-duplicate",
  }) as unknown as AnyWorkflowDefinition;

const withSignals = (signals: Record<string, SignalDefinition>): AnyWorkflowDefinition =>
  ({ ...baseDefinition(), signals }) as unknown as AnyWorkflowDefinition;

const withQueries = (queries: Record<string, QueryDefinition>): AnyWorkflowDefinition =>
  ({ ...baseDefinition(), queries }) as unknown as AnyWorkflowDefinition;

const withUpdates = (updates: Record<string, UpdateDefinition>): AnyWorkflowDefinition =>
  ({ ...baseDefinition(), updates }) as unknown as AnyWorkflowDefinition;

const knownSignal: SignalDefinition = { input: z.object({}) } as unknown as SignalDefinition;
const knownQuery: QueryDefinition = {
  input: z.object({}),
  output: z.object({}),
} as unknown as QueryDefinition;
const knownUpdate: UpdateDefinition = {
  input: z.object({}),
  output: z.object({}),
} as unknown as UpdateDefinition;

// Never invoked — every case here throws before `setHandler` binds a real
// handler, so the implementation body is unreachable.
const noopSignalHandler = (() => {
  throw new Error("must not be invoked");
}) as unknown as Parameters<typeof bindSignalHandler>[3];
const noopQueryHandler = (() => {
  throw new Error("must not be invoked");
}) as unknown as Parameters<typeof bindQueryHandler>[3];
const noopUpdateHandler = (() => {
  throw new Error("must not be invoked");
}) as unknown as Parameters<typeof bindUpdateHandler>[3];

/**
 * Runs `fn`, expects it to throw a {@link ContractMisuseError}, and returns
 * it — so the caller can assert the exact `.message` with `toBe`, not a
 * substring any of the other five guards' messages would also satisfy.
 */
function captureContractMisuse(fn: () => void): ContractMisuseError {
  try {
    fn();
  } catch (error) {
    if (error instanceof ContractMisuseError) return error;
    throw error;
  }
  throw new Error("expected ContractMisuseError to be thrown");
}

describe("bindSignalHandler — declaration-time misuse", () => {
  it("throws ContractMisuseError when the workflow declares no signals block", () => {
    const error = captureContractMisuse(() =>
      bindSignalHandler(baseDefinition(), "myWorkflow", "ping", noopSignalHandler),
    );
    expect(error.message).toBe(
      'Signal "ping" cannot be defined: workflow "myWorkflow" has no signals in its contract',
    );
  });

  it("throws ContractMisuseError when the signal name is not declared in the signals block", () => {
    const error = captureContractMisuse(() =>
      bindSignalHandler(
        withSignals({ known: knownSignal }),
        "myWorkflow",
        "typo",
        noopSignalHandler,
      ),
    );
    expect(error.message).toBe('Signal "typo" not found in workflow "myWorkflow" contract');
  });
});

describe("bindQueryHandler — declaration-time misuse", () => {
  it("throws ContractMisuseError when the workflow declares no queries block", () => {
    const error = captureContractMisuse(() =>
      bindQueryHandler(baseDefinition(), "myWorkflow", "status", noopQueryHandler),
    );
    expect(error.message).toBe(
      'Query "status" cannot be defined: workflow "myWorkflow" has no queries in its contract',
    );
  });

  it("throws ContractMisuseError when the query name is not declared in the queries block", () => {
    const error = captureContractMisuse(() =>
      bindQueryHandler(withQueries({ known: knownQuery }), "myWorkflow", "typo", noopQueryHandler),
    );
    expect(error.message).toBe('Query "typo" not found in workflow "myWorkflow" contract');
  });
});

describe("bindUpdateHandler — declaration-time misuse", () => {
  it("throws ContractMisuseError when the workflow declares no updates block", () => {
    const error = captureContractMisuse(() =>
      bindUpdateHandler(baseDefinition(), "myWorkflow", "bump", noopUpdateHandler),
    );
    expect(error.message).toBe(
      'Update "bump" cannot be defined: workflow "myWorkflow" has no updates in its contract',
    );
  });

  it("throws ContractMisuseError when the update name is not declared in the updates block", () => {
    const error = captureContractMisuse(() =>
      bindUpdateHandler(
        withUpdates({ known: knownUpdate }),
        "myWorkflow",
        "typo",
        noopUpdateHandler,
      ),
    );
    expect(error.message).toBe('Update "typo" not found in workflow "myWorkflow" contract');
  });
});
