import type { StandardSchemaV1 } from "@standard-schema/spec";
import {
  defineContract,
  defineQuery,
  defineSignal,
  defineUpdate,
  defineWorkflow,
} from "@temporal-contract/contract";
import { z } from "zod";

// Composition-first: resources defined individually, then composed.

/**
 * A schema whose `validate()` returns a Promise unconditionally, regardless
 * of input. Standard Schema types the async signature as `Promise<Result>`.
 */
const alwaysAsyncSchema: StandardSchemaV1<unknown, unknown> = {
  "~standard": {
    version: 1,
    vendor: "handlers-tests",
    validate: (value: unknown) => Promise.resolve({ value, issues: undefined }),
  },
};

const bump = defineSignal({ input: z.object({ by: z.number().int().positive() }) });

/**
 * Payload-less signal used to end `counter` deterministically, independent
 * of `bump`'s accumulated total. Two reasons this exists rather than a
 * `total >= 10` threshold:
 *
 * - it decouples termination from `bump`'s own correctness, so a regression
 *   in `bump`'s drop-and-log behavior fails an assertion fast instead of
 *   hanging the workflow (and the test) until the execution timeout;
 * - a zero-argument Temporal dispatch of a payload-less signal must extract
 *   to `undefined`, not `[]` (`defineSignal()` with no input materializes an
 *   `UndefinedInputSchema` that only accepts `undefined`/`null`) — `finish`
 *   is what proves that extraction is correct end-to-end.
 */
const finish = defineSignal();

const peek = defineQuery({ output: z.object({ total: z.number() }) });

/**
 * A second, input-bearing query. Its only job is to prove the worker's
 * `bindQueryHandler` still enforces input validation for a query
 * that (unlike `peek`) takes a payload — `describe`'s handler is only
 * reachable via `handle.raw.query(...)` in the spec, bypassing the typed
 * client's own (identical-schema) client-side check, which would otherwise
 * reject the same bad input before it ever left the process.
 */
const describe = defineQuery({
  input: z.string().min(1),
  output: z.object({ label: z.string(), total: z.number() }),
});

/**
 * Query whose handler deliberately returns a value the OUTPUT schema
 * rejects — the only way to prove `bindQueryHandler` validates a handler's
 * return value, not just its input.
 */
const brokenOutput = defineQuery({ output: z.object({ total: z.number() }) });

const applyDelta = defineUpdate({
  input: z.object({ delta: z.number().int().positive() }),
  output: z.object({ total: z.number() }),
});

/**
 * Update whose handler deliberately returns a value the OUTPUT schema
 * rejects — the update-side counterpart of `brokenOutput`.
 */
const brokenOutputUpdate = defineUpdate({
  input: z.object({}),
  output: z.object({ total: z.number() }),
});

/**
 * Update with an async-validating OUTPUT schema. Unlike a query (both
 * schema slots must be synchronous) or an update's INPUT schema (gated by
 * Temporal's synchronous validator slot), an update's output validation runs
 * inside the async handler body — never admission-gated — so an async
 * output schema is explicitly *allowed*, not a `ContractMisuseError`. This is the deliberate query/update asymmetry.
 */
const asyncOutputUpdate = defineUpdate({
  input: z.object({ text: z.string() }),
  output: alwaysAsyncSchema,
});

const counter = defineWorkflow({
  input: z.object({}),
  output: z.object({ total: z.number() }),
  startPolicy: "allow-duplicate",
  signals: { bump, finish },
  queries: { peek, describe, brokenOutput },
  updates: { applyDelta, brokenOutputUpdate, asyncOutputUpdate },
});

/**
 * A schema that validates SYNCHRONOUSLY for some values (a symbol) but goes
 * ASYNC for any real payload — the shape of a zod `.refine(async ...)`, whose
 * async step only runs once the synchronous base check passes. Only a
 * per-call check can catch it.
 */
const probeDodgingSchema: StandardSchemaV1<string, string> = {
  "~standard": {
    version: 1,
    vendor: "handlers-tests",
    validate: (input: unknown) =>
      typeof input === "symbol"
        ? { value: input as unknown as string, issues: undefined }
        : Promise.resolve({ value: input as string, issues: undefined }),
  },
};

/**
 * A validation result that is `PromiseLike` but NOT a `Promise` — the shape
 * an `instanceof Promise` guard misses. Standard Schema types the async
 * signature as `Promise<Result>`, but an implementation may legally hand
 * back any `PromiseLike` (a wrapper, a deferred, a thenable from another
 * realm). The per-call guard uses a structural `isThenable` check rather
 * than `instanceof Promise` specifically to catch this.
 */
function bareThenable(value: unknown): Promise<{ value: unknown; issues: undefined }> {
  // oxlint-disable-next-line unicorn/no-thenable -- the thenable IS the fixture: proves the sync guard catches a non-Promise PromiseLike
  const thenable = { then: (resolve: (r: unknown) => void) => resolve({ value }) };
  return thenable as unknown as Promise<{ value: unknown; issues: undefined }>;
}

const thenableDodgingSchema: StandardSchemaV1<string, string> = {
  "~standard": {
    version: 1,
    vendor: "handlers-tests",
    validate: (input: unknown) =>
      typeof input === "symbol"
        ? { value: input as unknown as string, issues: undefined }
        : (bareThenable(input) as unknown as { value: string; issues: undefined }),
  },
};

const probeDodging = defineQuery({
  input: probeDodgingSchema,
  output: z.object({ echoed: z.string() }),
});
const thenableDodging = defineQuery({
  input: thenableDodgingSchema,
  output: z.object({ echoed: z.string() }),
});

const asyncCheckedQueryOutput = defineQuery({ output: alwaysAsyncSchema });

const asyncCheckedUpdateInput = defineUpdate({
  input: alwaysAsyncSchema,
  output: z.object({ ok: z.boolean() }),
});

/**
 * Every sync-only schema slot fed an async schema — query input (twice: a
 * conditionally-async schema and a bare thenable), query output, update
 * input. Isolated from `counter` so its failure/hang modes stay easy to
 * reason about independently.
 */
const probeEdgeCases = defineWorkflow({
  input: z.object({}),
  output: z.object({}),
  startPolicy: "allow-duplicate",
  queries: { probeDodging, thenableDodging, asyncCheckedQueryOutput },
  updates: { asyncCheckedUpdateInput },
});

/**
 * Handlers that throw a contract error: the update must be rejected with it,
 * the signal must fail the workflow with it — never a workflow-task retry
 * loop.
 */
const rejecting = defineWorkflow({
  input: z.object({}),
  output: z.object({}),
  startPolicy: "allow-duplicate",
  errors: { Rejected: { nonRetryable: true } },
  signals: { reject: defineSignal() },
  updates: { rejectUpdate: defineUpdate({ input: z.object({}), output: z.object({}) }) },
});

// D1 wire format: the handler receives the PARSED (transformed) input —
// the receiving side of the input boundary — while its ORIGINAL return
// value crosses the wire untransformed — the sending side of the output
// boundary, parsed by the receiver (the client, or here `handle.raw`, which
// deliberately does NOT re-parse so the raw wire value is visible).
const transformingText = z.object({ text: z.string().transform((s) => `${s}!`) });
const transformingOutput = z.object({
  receivedText: z.string(),
  n: z.number().transform((n) => n * 2),
});

const note = defineSignal({ input: transformingText });
const peekNote = defineQuery({ output: z.object({ text: z.string() }) });
const peekText = defineQuery({ input: transformingText, output: transformingOutput });
const poke = defineUpdate({ input: transformingText, output: transformingOutput });

const transformWorkflow = defineWorkflow({
  input: z.object({}),
  output: z.object({}),
  startPolicy: "allow-duplicate",
  signals: { note },
  queries: { peekNote, peekText },
  updates: { poke },
});

export const handlersContract = defineContract({
  taskQueue: "handlers-tests",
  workflows: {
    counter,
    probeEdgeCases,
    rejecting,
    transformWorkflow,
  },
});
