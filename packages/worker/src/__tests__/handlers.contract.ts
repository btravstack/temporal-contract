import {
  defineContract,
  defineQuery,
  defineSignal,
  defineUpdate,
  defineWorkflow,
} from "@temporal-contract/contract";
import { z } from "zod";

// Composition-first: resources defined individually, then composed.

const bump = defineSignal({ input: z.object({ by: z.number().int().positive() }) });

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

const applyDelta = defineUpdate({
  input: z.object({ delta: z.number().int().positive() }),
  output: z.object({ total: z.number() }),
});

const counter = defineWorkflow({
  input: z.object({}),
  output: z.object({ total: z.number() }),
  signals: { bump },
  queries: { peek, describe },
  updates: { applyDelta },
});

/**
 * Async-validating query input schema. A zod `.refine(async ...)` won't do
 * here: fed the bind-time probe's opaque sentinel (not a string), zod's base
 * type check fails synchronously *before* the async refine ever runs, so the
 * probe would see a sync result and wave it through — that's the documented
 * "probe-dodging schema" case, caught only by the *per-call* guard once a
 * real (string-shaped) payload arrives, which never happens for a query
 * nobody calls. To prove the *bind-time* probe specifically, this schema's
 * `validate()` returns a Promise unconditionally, regardless of input.
 */
const asyncCheckedQuery = defineQuery({
  input: {
    "~standard": {
      version: 1,
      vendor: "handlers-tests",
      validate: (value: unknown) => Promise.resolve({ value, issues: undefined }),
    },
  },
  output: z.object({ ok: z.boolean() }),
});

const bindsAsyncQuerySchema = defineWorkflow({
  input: z.object({}),
  output: z.object({}),
  queries: { asyncCheckedQuery },
});

export const handlersContract = defineContract({
  taskQueue: "handlers-tests",
  workflows: { counter, bindsAsyncQuerySchema },
});
