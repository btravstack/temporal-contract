import { defineSignal as defineContractSignal, defineWorkflow } from "@temporal-contract/contract";
/**
 * Coverage for the hoisted signal/query/update bind helpers
 * (`bindSignalHandler`, `bindQueryHandler`, `bindUpdateHandler`).
 *
 * Mocks `@temporalio/workflow`'s `defineSignal/Query/Update`, `setHandler`,
 * and `log` so the helpers are exercisable outside a real workflow
 * context. Asserts that:
 *
 * - missing-block runtime guards fire with a `ContractMisuseError` (a
 *   non-retryable ApplicationFailure — a plain Error would hang the
 *   execution in infinite Workflow Task retries),
 * - unknown-name runtime guards fire the same way,
 * - invalid *signal* payloads are dropped and logged (`log.warn`), never
 *   thrown — signals are fire-and-forget (D2),
 * - query/update validation failures throw the right typed error class,
 * - the handler receives the *validated* (parsed) input — the worker is the
 *   receiving side of the input boundary, so the parse happens exactly once
 *   here (the client validated but transmitted the caller's original value),
 * - query's sync-only validation guard rejects async-validating schemas,
 * - update/query outputs are validated against the contract, but the
 *   handler's ORIGINAL return value is what resolves — the client parses the
 *   result on receive, so a transforming output schema applies exactly once.
 *
 * Closes #185.
 */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

const captured: Array<{
  kind: string;
  name: string;
  impl: (...args: unknown[]) => unknown;
  validator?: (...args: unknown[]) => void;
}> = [];

vi.mock("@temporalio/workflow", () => ({
  defineSignal: vi.fn((name: string) => ({ kind: "signal", name }) as const),
  defineQuery: vi.fn((name: string) => ({ kind: "query", name }) as const),
  defineUpdate: vi.fn((name: string) => ({ kind: "update", name }) as const),
  log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() },
  setHandler: vi.fn(
    (
      handle: { kind: string; name: string },
      impl: (...args: unknown[]) => unknown,
      options?: { validator?: (...args: unknown[]) => void },
    ) => {
      captured.push({
        kind: handle.kind,
        name: handle.name,
        impl,
        ...(options?.validator ? { validator: options.validator } : {}),
      });
    },
  ),
}));

const { log } = await import("@temporalio/workflow");
const { bindSignalHandler, bindQueryHandler, bindUpdateHandler } = await import("./handlers.js");
const {
  ContractMisuseError,
  QueryInputValidationError,
  QueryOutputValidationError,
  UpdateInputValidationError,
  UpdateOutputValidationError,
} = await import("./errors.js");

// Schema library used as a stand-in for an async-only validator. Each
// validate() call returns a Promise rather than the parsed value — used
// to verify the query helper trips the sync-only guard rather than
// silently breaking Temporal's query semantics.
const asyncStringSchema = {
  "~standard": {
    version: 1 as const,
    vendor: "test-async",
    validate: (input: unknown) => Promise.resolve({ value: input, issues: undefined }),
  },
};

const workflow = defineWorkflow({
  input: z.object({ id: z.string() }),
  output: z.object({}),
  signals: {
    cancel: { input: z.tuple([z.object({ reason: z.string() })]) },
  },
  queries: {
    progress: { input: z.tuple([]), output: z.number() },
  },
  updates: {
    bumpAttempt: { input: z.tuple([z.number()]), output: z.object({ attempt: z.number() }) },
  },
});

describe("bindSignalHandler", () => {
  it("validates the payload and forwards the parsed value to the handler", async () => {
    captured.length = 0;
    const handler = vi.fn();
    bindSignalHandler(workflow, "probe", "cancel", handler as never);

    const entry = captured.find((c) => c.kind === "signal" && c.name === "cancel");
    expect(entry).toBeDefined();
    await entry!.impl([{ reason: "user requested" }]);

    // The signal's input schema is `z.tuple([{ reason }])`, so the
    // validated value the handler receives is the parsed tuple.
    expect(handler).toHaveBeenCalledWith([{ reason: "user requested" }]);
  });

  it("drops the signal and logs a warning when the payload doesn't match the contract (D2)", async () => {
    captured.length = 0;
    vi.mocked(log.warn).mockClear();
    const handler = vi.fn();
    bindSignalHandler(workflow, "probe", "cancel", handler as never);
    const entry = captured.find((c) => c.kind === "signal" && c.name === "cancel")!;

    // Wrong shape — missing `reason`. Signals are fire-and-forget: an
    // invalid payload must never fail the execution, so the handler resolves
    // without throwing, the user handler is never invoked, and the drop is
    // logged with the signal name plus an issues summary.
    await expect(entry.impl([{ wrongField: 1 }])).resolves.toBeUndefined();

    expect(handler).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledTimes(1);
    const message = vi.mocked(log.warn).mock.calls[0]![0] as string;
    expect(message).toContain('Dropped signal "cancel"');
    expect(message).toContain("input validation failed");
  });

  it("throws ContractMisuseError when the workflow has no signals block", () => {
    const noSignals = defineWorkflow({
      input: z.object({}),
      output: z.object({}),
    });
    const bind = () => bindSignalHandler(noSignals, "probe", "cancel", vi.fn() as never);
    expect(bind).toThrow(ContractMisuseError);
    expect(bind).toThrow(/workflow "probe" has no signals/);
  });

  it("throws ContractMisuseError when the signal name isn't declared", () => {
    const bind = () => bindSignalHandler(workflow, "probe", "nope", vi.fn() as never);
    expect(bind).toThrow(ContractMisuseError);
    expect(bind).toThrow(/Signal "nope" not found/);
  });

  it("maps a zero-argument send to `undefined` for payload-less signals", async () => {
    // Pairs with the contract change: `defineSignal()` (no input schema)
    // materializes an UndefinedInputSchema that only accepts undefined/null.
    // A zero-arg Temporal dispatch must therefore extract to `undefined`,
    // not `[]`.
    captured.length = 0;
    const handler = vi.fn();
    const wfWithPayloadlessSignal = defineWorkflow({
      input: z.object({}),
      output: z.object({}),
      signals: { shutdown: defineContractSignal() },
    });
    bindSignalHandler(wfWithPayloadlessSignal, "probe", "shutdown", handler as never);
    const entry = captured.find((c) => c.kind === "signal" && c.name === "shutdown")!;

    await entry.impl(); // zero args — Temporal dispatch of a payload-less signal

    expect(handler).toHaveBeenCalledWith(undefined);
  });
});

describe("bindQueryHandler", () => {
  it("validates input + output synchronously and returns the parsed result", () => {
    captured.length = 0;
    const handler = vi.fn().mockReturnValue(42);
    bindQueryHandler(workflow, "probe", "progress", handler as never);

    const entry = captured.find((c) => c.kind === "query" && c.name === "progress")!;
    const result = entry.impl([]);
    expect(handler).toHaveBeenCalledWith([]);
    expect(result).toBe(42);
  });

  it("throws QueryInputValidationError on bad input", () => {
    captured.length = 0;
    bindQueryHandler(workflow, "probe", "progress", vi.fn().mockReturnValue(0) as never);
    const entry = captured.find((c) => c.kind === "query" && c.name === "progress")!;
    // Pass a non-tuple input.
    expect(() => entry.impl(["bad"])).toThrow(QueryInputValidationError);
  });

  it("throws QueryOutputValidationError when handler returns a value the contract rejects", () => {
    captured.length = 0;
    // Handler returns wrong type (string instead of number) — output schema rejects.
    bindQueryHandler(
      workflow,
      "probe",
      "progress",
      vi.fn().mockReturnValue("not a number") as never,
    );
    const entry = captured.find((c) => c.kind === "query" && c.name === "progress")!;
    expect(() => entry.impl([])).toThrow(QueryOutputValidationError);
  });

  it("throws ContractMisuseError AT BIND TIME when the input schema validates asynchronously", () => {
    // An async schema (e.g. zod async refine) used to pass declaration and
    // fail only when the first live query arrived; the bind-time probe moves
    // the failure to handler binding with a message naming the workflow,
    // handler kind, name, and direction.
    captured.length = 0;
    const wfWithAsyncQuery = defineWorkflow({
      input: z.object({}),
      output: z.object({}),
      queries: {
        progress: { input: asyncStringSchema, output: z.number() },
      },
    });
    const bind = () =>
      bindQueryHandler(wfWithAsyncQuery, "probe", "progress", vi.fn().mockReturnValue(1) as never);
    expect(bind).toThrow(ContractMisuseError);
    expect(bind).toThrow(
      /Query "progress" of workflow "probe": the input schema validates asynchronously/,
    );
    // Nothing was registered — the bind failed before setHandler.
    expect(captured.find((c) => c.kind === "query" && c.name === "progress")).toBeUndefined();
  });

  it("throws ContractMisuseError AT BIND TIME when the output schema validates asynchronously", () => {
    captured.length = 0;
    const wfWithAsyncOutput = defineWorkflow({
      input: z.object({}),
      output: z.object({}),
      queries: {
        progress: { input: z.tuple([]), output: asyncStringSchema },
      },
    });
    const bind = () =>
      bindQueryHandler(
        wfWithAsyncOutput,
        "probe",
        "progress",
        vi.fn().mockReturnValue("x") as never,
      );
    expect(bind).toThrow(ContractMisuseError);
    expect(bind).toThrow(
      /Query "progress" of workflow "probe": the output schema validates asynchronously/,
    );
  });

  it("a synchronously-throwing schema passes the bind-time probe (a sync throw proves synchronicity)", () => {
    // The probe feeds a sentinel to validate(); some libraries throw
    // synchronously on garbage input. That throw must be treated as "fine,
    // it's synchronous" — not as a probe failure.
    captured.length = 0;
    const throwingSchema = {
      "~standard": {
        version: 1 as const,
        vendor: "test-throwing",
        validate: (input: unknown) => {
          if (typeof input === "symbol") {
            // oxlint-disable-next-line unthrown/no-throw -- test double: simulates a schema library that throws synchronously on garbage input
            throw new TypeError("cannot validate a symbol");
          }
          return { value: input, issues: undefined };
        },
      },
    };
    const wf = defineWorkflow({
      input: z.object({}),
      output: z.object({}),
      queries: {
        progress: { input: throwingSchema, output: z.number() },
      },
    });
    expect(() =>
      bindQueryHandler(wf, "probe", "progress", vi.fn().mockReturnValue(2) as never),
    ).not.toThrow();
    const entry = captured.find((c) => c.kind === "query" && c.name === "progress")!;
    expect(entry.impl("anything")).toBe(2);
  });

  it("keeps the per-call sync guard as defense-in-depth for schemas that defeat the probe", () => {
    // A pathological schema that answers the probe synchronously but goes
    // async for real payloads: the bind succeeds, and the per-call guard
    // still trips a ContractMisuseError instead of corrupting query
    // semantics.
    captured.length = 0;
    const probeDodgingSchema = {
      "~standard": {
        version: 1 as const,
        vendor: "test-dodging",
        validate: (input: unknown) =>
          typeof input === "symbol"
            ? { value: input, issues: undefined }
            : Promise.resolve({ value: input, issues: undefined }),
      },
    };
    const wf = defineWorkflow({
      input: z.object({}),
      output: z.object({}),
      queries: {
        progress: { input: probeDodgingSchema, output: z.number() },
      },
    });
    bindQueryHandler(wf, "probe", "progress", vi.fn().mockReturnValue(1) as never);
    const entry = captured.find((c) => c.kind === "query" && c.name === "progress")!;
    expect(() => entry.impl(["x"])).toThrow(ContractMisuseError);
    expect(() => entry.impl(["x"])).toThrow(/validation must be synchronous/);
  });

  it("throws ContractMisuseError when the workflow has no queries block", () => {
    const noQueries = defineWorkflow({
      input: z.object({}),
      output: z.object({}),
    });
    const bind = () => bindQueryHandler(noQueries, "probe", "progress", vi.fn() as never);
    expect(bind).toThrow(ContractMisuseError);
    expect(bind).toThrow(/workflow "probe" has no queries/);
  });

  it("throws ContractMisuseError when the query name isn't declared", () => {
    const bind = () => bindQueryHandler(workflow, "probe", "nope", vi.fn() as never);
    expect(bind).toThrow(ContractMisuseError);
    expect(bind).toThrow(/Query "nope" not found/);
  });
});

describe("bindUpdateHandler", () => {
  it("validates input + output and forwards the parsed input to the handler", async () => {
    captured.length = 0;
    const handler = vi.fn(async () => ({ attempt: 3 }));
    bindUpdateHandler(workflow, "probe", "bumpAttempt", handler as never);

    const entry = captured.find((c) => c.kind === "update" && c.name === "bumpAttempt")!;
    const result = await entry.impl([7]);
    expect(handler).toHaveBeenCalledWith([7]);
    expect(result).toEqual({ attempt: 3 });
  });

  it("registers a synchronous validator alongside the handler (admission-time rejection)", () => {
    // Temporal's `setHandler` for updates accepts an optional `validator`
    // option. Validators run synchronously *before* the update is admitted —
    // throwing rejects the update at admission with no workflow history
    // event written, and the client sees `WorkflowUpdateValidationRejectedError`
    // instead of `WorkflowUpdateFailedError`. Without the validator slot the
    // input-validation failure path produces a history scar for every
    // malformed update, which is a free correctness win to fix.
    captured.length = 0;
    bindUpdateHandler(workflow, "probe", "bumpAttempt", (async () => ({ attempt: 0 })) as never);
    const entry = captured.find((c) => c.kind === "update" && c.name === "bumpAttempt")!;
    expect(entry.validator).toBeTypeOf("function");
  });

  it("validator throws UpdateInputValidationError on bad input (rejected at admission)", () => {
    captured.length = 0;
    bindUpdateHandler(workflow, "probe", "bumpAttempt", (async () => ({ attempt: 0 })) as never);
    const entry = captured.find((c) => c.kind === "update" && c.name === "bumpAttempt")!;
    // Drive the validator directly — this is what Temporal does at update
    // admission. The thrown error must be the typed validation error class
    // (which, on the client side, becomes `WorkflowUpdateValidationRejectedError`).
    expect(() => entry.validator!(["not a number"])).toThrow(UpdateInputValidationError);
  });

  it("validator accepts well-formed input without throwing", () => {
    captured.length = 0;
    bindUpdateHandler(workflow, "probe", "bumpAttempt", (async () => ({ attempt: 3 })) as never);
    const entry = captured.find((c) => c.kind === "update" && c.name === "bumpAttempt")!;
    expect(() => entry.validator!([7])).not.toThrow();
  });

  it("throws ContractMisuseError AT BIND TIME when the update input schema validates asynchronously", () => {
    // Temporal's update validator slot is documented as synchronous —
    // returning a Promise from the validator silently breaks admission
    // semantics. Standard Schema permits async validate(), so the typical
    // offender is Zod with `.refine(async)` on an update input. The
    // bind-time probe surfaces that when the handler is bound (worker
    // startup / first workflow task) instead of on the first live update.
    captured.length = 0;
    const wfWithAsyncUpdate = defineWorkflow({
      input: z.object({}),
      output: z.object({}),
      updates: {
        bumpAttempt: { input: asyncStringSchema, output: z.object({ attempt: z.number() }) },
      },
    });
    const bind = () =>
      bindUpdateHandler(wfWithAsyncUpdate, "probe", "bumpAttempt", (async () => ({
        attempt: 1,
      })) as never);
    expect(bind).toThrow(ContractMisuseError);
    expect(bind).toThrow(
      /Update "bumpAttempt" of workflow "probe": the input schema validates asynchronously/,
    );
    expect(captured.find((c) => c.kind === "update" && c.name === "bumpAttempt")).toBeUndefined();
  });

  it("an async update OUTPUT schema is allowed (output validation runs in the async handler body)", () => {
    captured.length = 0;
    const wfWithAsyncOutput = defineWorkflow({
      input: z.object({}),
      output: z.object({}),
      updates: {
        bumpAttempt: { input: z.tuple([z.number()]), output: asyncStringSchema },
      },
    });
    expect(() =>
      bindUpdateHandler(wfWithAsyncOutput, "probe", "bumpAttempt", (async () => ({
        attempt: 1,
      })) as never),
    ).not.toThrow();
  });

  it("handler runs and returns parsed output when input is valid", async () => {
    captured.length = 0;
    const handler = vi.fn(async () => ({ attempt: 9 }));
    bindUpdateHandler(workflow, "probe", "bumpAttempt", handler as never);
    const entry = captured.find((c) => c.kind === "update" && c.name === "bumpAttempt")!;
    // Validator passes, then handler is invoked with the parsed input.
    expect(() => entry.validator!([9])).not.toThrow();
    const result = await entry.impl([9]);
    expect(handler).toHaveBeenCalledWith([9]);
    expect(result).toEqual({ attempt: 9 });
  });

  it("throws UpdateOutputValidationError when the handler returns the wrong shape", async () => {
    captured.length = 0;
    bindUpdateHandler(workflow, "probe", "bumpAttempt", (async () => ({ wrongKey: 1 })) as never);
    const entry = captured.find((c) => c.kind === "update" && c.name === "bumpAttempt")!;
    // Output validation runs inside the handler body (post-admission), so
    // its error class is unchanged.
    await expect(entry.impl([1])).rejects.toBeInstanceOf(UpdateOutputValidationError);
  });

  it("throws ContractMisuseError when the workflow has no updates block", () => {
    const noUpdates = defineWorkflow({
      input: z.object({}),
      output: z.object({}),
    });
    const bind = () => bindUpdateHandler(noUpdates, "probe", "bumpAttempt", vi.fn() as never);
    expect(bind).toThrow(ContractMisuseError);
    expect(bind).toThrow(/workflow "probe" has no updates/);
  });

  it("throws ContractMisuseError when the update name isn't declared", () => {
    const bind = () => bindUpdateHandler(workflow, "probe", "nope", vi.fn() as never);
    expect(bind).toThrow(ContractMisuseError);
    expect(bind).toThrow(/Update "nope" not found/);
  });
});

describe("wire format (validate on send, parse on receive)", () => {
  // D1: handler input is the RECEIVING side of the boundary — parsed exactly
  // once here. Handler output is the SENDING side — validated, but the
  // handler's ORIGINAL return value goes over the wire; the client parses it.
  const transformWorkflow = defineWorkflow({
    input: z.object({}),
    output: z.object({}),
    signals: {
      note: { input: z.object({ text: z.string().transform((s) => `${s}!`) }) },
    },
    queries: {
      peek: {
        input: z.object({ text: z.string().transform((s) => `${s}!`) }),
        output: z.object({ n: z.number().transform((n) => n * 2) }),
      },
    },
    updates: {
      poke: {
        input: z.object({ text: z.string().transform((s) => `${s}!`) }),
        output: z.object({ n: z.number().transform((n) => n * 2) }),
      },
    },
  });

  it("signal handler receives the PARSED input (transform applied once)", async () => {
    captured.length = 0;
    const handler = vi.fn();
    bindSignalHandler(transformWorkflow, "probe", "note", handler as never);
    const entry = captured.find((c) => c.kind === "signal" && c.name === "note")!;

    await entry.impl({ text: "hi" });

    expect(handler).toHaveBeenCalledWith({ text: "hi!" });
  });

  it("query handler receives the PARSED input and its ORIGINAL return goes over the wire", () => {
    captured.length = 0;
    const handler = vi.fn().mockReturnValue({ n: 21 });
    bindQueryHandler(transformWorkflow, "probe", "peek", handler as never);
    const entry = captured.find((c) => c.kind === "query" && c.name === "peek")!;

    const result = entry.impl({ text: "hi" });

    expect(handler).toHaveBeenCalledWith({ text: "hi!" });
    // Validated against the output schema, but transmitted untransformed —
    // the client parses the query result on receive (would be 42 if the
    // transform were applied here too).
    expect(result).toEqual({ n: 21 });
  });

  it("update handler receives the PARSED input and its ORIGINAL return goes over the wire", async () => {
    captured.length = 0;
    const handler = vi.fn(async () => ({ n: 21 }));
    bindUpdateHandler(transformWorkflow, "probe", "poke", handler as never);
    const entry = captured.find((c) => c.kind === "update" && c.name === "poke")!;

    const result = await entry.impl({ text: "hi" });

    expect(handler).toHaveBeenCalledWith({ text: "hi!" });
    expect(result).toEqual({ n: 21 });
  });
});
