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
 * of input. Standard Schema types the async signature as `Promise<Result>`,
 * and real async-validating libraries (e.g. Zod with `.refine(async ...)`)
 * only go async for *some* inputs — but for the bind-time probe (which feeds
 * an opaque sentinel), only an unconditionally-async schema reliably trips
 * it. A zod `.refine(async ...)` schema does NOT do this: fed the sentinel
 * (not a string), zod's synchronous base type check fails first and the
 * async refine never runs, so the probe sees a synchronous result and waves
 * it through — see `probeDodgingSchema` below for that exact case.
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
 * bind-time `bindQueryHandler` still enforces input validation for a query
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
 * output schema is explicitly *allowed*, not a bind-time
 * `ContractMisuseError`. This is the deliberate query/update asymmetry.
 */
const asyncOutputUpdate = defineUpdate({
  input: z.object({ text: z.string() }),
  output: alwaysAsyncSchema,
});

const counter = defineWorkflow({
  input: z.object({}),
  output: z.object({ total: z.number() }),
  signals: { bump, finish },
  queries: { peek, describe, brokenOutput },
  updates: { applyDelta, brokenOutputUpdate, asyncOutputUpdate },
});

const asyncCheckedQuery = defineQuery({
  input: alwaysAsyncSchema,
  output: z.object({ ok: z.boolean() }),
});

const bindsAsyncQuerySchema = defineWorkflow({
  input: z.object({}),
  output: z.object({}),
  queries: { asyncCheckedQuery },
});

/**
 * Async-validating query OUTPUT schema (as opposed to `asyncCheckedQuery`'s
 * async INPUT). `bindQueryHandler` probes both schema slots at bind time —
 * this workflow exists to prove the *output* slot's probe fires
 * independently of the input slot's, i.e. that `bindQueryHandler` doesn't
 * just check input and skip output.
 */
const asyncCheckedQueryOutput = defineQuery({ output: alwaysAsyncSchema });

const bindsAsyncQueryOutputSchema = defineWorkflow({
  input: z.object({}),
  output: z.object({}),
  queries: { asyncCheckedQueryOutput },
});

/**
 * Async-validating update INPUT schema — the update-side counterpart of
 * `asyncCheckedQuery`. `bindUpdateHandler` runs its own, separate
 * `assertSyncSchema(updateDef.input, ...)` call site; proving the query
 * side alone doesn't cover a regression that removes this specific call.
 */
const asyncCheckedUpdateInput = defineUpdate({
  input: alwaysAsyncSchema,
  output: z.object({ ok: z.boolean() }),
});

const bindsAsyncUpdateSchema = defineWorkflow({
  input: z.object({}),
  output: z.object({}),
  updates: { asyncCheckedUpdateInput },
});

/**
 * A schema whose `validate()` throws SYNCHRONOUSLY when fed the bind-time
 * probe's opaque sentinel (not a string), and validates normally for real
 * string payloads. The probe must treat a synchronous throw as "fine, it's
 * synchronous" (not a probe failure) — this is the schema that proves that,
 * end to end: bind must succeed, and a real query afterward must still work.
 */
const syncThrowProbeSchema: StandardSchemaV1<string, string> = {
  "~standard": {
    version: 1,
    vendor: "handlers-tests",
    validate: (input: unknown) => {
      if (typeof input !== "string") {
        // oxlint-disable-next-line unthrown/no-throw -- test double: simulates a schema library that throws synchronously on garbage input
        throw new TypeError("expected a string");
      }
      return { value: input, issues: undefined };
    },
  },
};

/**
 * A pathological schema that answers the bind-time probe SYNCHRONOUSLY
 * (fed the opaque sentinel, a symbol) but goes ASYNC for any real payload.
 * The bind-time probe cannot catch this — it only proves the PER-CALL guard
 * (defense-in-depth) still trips a `ContractMisuseError` instead of
 * corrupting query semantics.
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

const syncThrowProbe = defineQuery({
  input: syncThrowProbeSchema,
  output: z.object({ echoed: z.string() }),
});
const probeDodging = defineQuery({
  input: probeDodgingSchema,
  output: z.object({ echoed: z.string() }),
});
const thenableDodging = defineQuery({
  input: thenableDodgingSchema,
  output: z.object({ echoed: z.string() }),
});

/**
 * Isolates the three schema-probe edge cases above from `counter` so each
 * workflow's failure/hang modes stay easy to reason about independently.
 */
const probeEdgeCases = defineWorkflow({
  input: z.object({}),
  output: z.object({}),
  queries: { syncThrowProbe, probeDodging, thenableDodging },
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
  signals: { note },
  queries: { peekNote, peekText },
  updates: { poke },
});

export const handlersContract = defineContract({
  taskQueue: "handlers-tests",
  workflows: {
    counter,
    bindsAsyncQuerySchema,
    bindsAsyncQueryOutputSchema,
    bindsAsyncUpdateSchema,
    probeEdgeCases,
    transformWorkflow,
  },
});
