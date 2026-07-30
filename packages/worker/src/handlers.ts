// Top-level helpers for binding signal / query / update handlers to a
// running workflow. Previously nested inside `declareWorkflow`'s closure
// (#185), they're hoisted here so the bodies aren't reallocated on each
// workflow invocation. The typed call-site surface is preserved at the
// context-assignment site in `workflow.ts` (the arrow that forwards into
// these helpers carries the contract-derived generic constraints).
//
// Internally these are loosely typed (string names, broad `*Definition`
// inputs); the call sites already do the cast against the typed
// `WorkflowContext` shape, so the typed-vs-runtime split is the same as
// it was before the hoist.
import type {
  AnyWorkflowDefinition,
  QueryDefinition,
  SignalDefinition,
  UpdateDefinition,
} from "@temporal-contract/contract";
import { summarizeIssues } from "@temporal-contract/contract";
import { defineQuery, defineSignal, defineUpdate, log, setHandler } from "@temporalio/workflow";

import {
  ContractMisuseError,
  QueryInputValidationError,
  QueryOutputValidationError,
  UpdateInputValidationError,
  UpdateOutputValidationError,
} from "./errors.js";
import { extractHandlerInput } from "./internal.js";
import type { WorkerInferInput, WorkerInferOutput } from "./types.js";

/**
 * Signal handler implementation
 *
 * Processes signal input and can optionally perform asynchronous operations.
 * Should not return a value (signals are fire-and-forget).
 */
export type SignalHandlerImplementation<TSignal extends SignalDefinition> = (
  args: WorkerInferInput<TSignal>,
) => void | Promise<void>;

/**
 * Query handler implementation
 *
 * Processes query input and returns a synchronous response.
 * Must be synchronous to satisfy Temporal's query constraints.
 */
export type QueryHandlerImplementation<TQuery extends QueryDefinition> = (
  args: WorkerInferInput<TQuery>,
) => WorkerInferOutput<TQuery>;

/**
 * Update handler implementation
 *
 * Processes update input and returns a validated response after modifying workflow state.
 * Can perform asynchronous operations.
 */
export type UpdateHandlerImplementation<TUpdate extends UpdateDefinition> = (
  args: WorkerInferInput<TUpdate>,
) => Promise<WorkerInferOutput<TUpdate>>;

/**
 * The (verbatim-shared) message for the update input schema's sync-only
 * requirement — Temporal's update validator slot is synchronous, and the
 * same schema is re-run inside the handler body, so both call sites must
 * report the identical constraint.
 */
function updateInputMustBeSynchronousMessage(updateName: string): string {
  return (
    `Update "${updateName}" input validation must be synchronous. Use a schema library that ` +
    `supports synchronous validation for update inputs (Temporal's update validator slot is synchronous).`
  );
}

/**
 * Sentinel fed to a schema's `validate` when probing for synchronicity. Its
 * validity is irrelevant — only whether `validate` returns a thenable.
 */
const SYNC_PROBE_SENTINEL = Symbol("temporal-contract.sync-schema-probe");

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/**
 * Bind-time probe for the sync-only schema slots (query input/output, update
 * input). Standard Schema permits `validate` to return a Promise (e.g. Zod
 * with an async `.refine`), but Temporal runs query handlers and the update
 * validator slot synchronously — an async schema would pass declaration and
 * only blow up when the first live request arrives. Probing at
 * `handleQuery`/`handleUpdate` bind time (i.e. on the first workflow task
 * that registers the handler) moves that failure to worker startup/binding,
 * where it is a clear {@link ContractMisuseError} instead of a mid-traffic
 * surprise.
 *
 * The probe invokes `validate` on an opaque sentinel and only inspects
 * whether the result is a thenable. Any synchronous **throw** counts as
 * "fine, it's synchronous": a sync validation error on the sentinel is
 * expected and proves synchronicity. A returned thenable is the async
 * signature — its eventual settlement is silenced (so a rejecting probe
 * can't trip unhandled-rejection reporting) and the bind fails immediately.
 */
function assertSyncSchema(
  schema: { "~standard": { validate: (value: unknown) => unknown } },
  location: {
    workflowName: string;
    handlerKind: "Query" | "Update";
    handlerName: string;
    direction: "input" | "output";
  },
): void {
  let probeResult: unknown;
  try {
    probeResult = schema["~standard"].validate(SYNC_PROBE_SENTINEL);
  } catch {
    // A synchronous throw on the sentinel proves the schema validates
    // synchronously — exactly what this probe is checking for.
    return;
  }
  if (isThenable(probeResult)) {
    // Detach the probe's eventual settlement — we only cared about the shape.
    probeResult.then(
      () => undefined,
      () => undefined,
    );
    const requirement =
      location.handlerKind === "Query"
        ? "Temporal query handlers run synchronously"
        : "Temporal's update validator slot is synchronous";
    // oxlint-disable-next-line unthrown/no-throw -- sanctioned ContractMisuseError model: bind-time fail-fast as a non-retryable ApplicationFailure (CLAUDE.md rule 2 exception)
    throw new ContractMisuseError(
      `${location.handlerKind} "${location.handlerName}" of workflow "${location.workflowName}": ` +
        `the ${location.direction} schema validates asynchronously (its validate() returned a Promise, ` +
        `e.g. an async refine), but ${requirement}. ` +
        `Use a synchronously-validating schema for this ${location.direction}.`,
    );
  }
}

/**
 * Bind a typed signal handler to the running workflow. Validates the
 * signal payload against the contract's input schema before invoking the
 * user-supplied handler.
 *
 * An invalid payload is **dropped and logged** (`log.warn` via
 * `@temporalio/workflow`'s workflow-safe logger), never thrown: signals are
 * fire-and-forget messages that any stale or non-typed client can send, and
 * throwing a non-retryable failure from the signal handler would terminally
 * kill the whole workflow execution over a message the workflow never asked
 * for.
 *
 * The runtime guard against a missing `signals` block — and an unknown
 * signal name within it — covers the union-typed-`workflowName` case
 * where the type system's keyset constraint collapses; without the
 * check, a caller would see `Cannot read properties of undefined`
 * instead of a controlled error. Both guards throw
 * {@link ContractMisuseError} (a non-retryable `ApplicationFailure`) so the
 * programming bug fails the execution terminally instead of hanging it in
 * an infinite Workflow Task retry loop.
 */
export function bindSignalHandler(
  workflowDefinition: AnyWorkflowDefinition,
  workflowName: string,
  signalName: string,
  handler: SignalHandlerImplementation<SignalDefinition>,
): void {
  if (!workflowDefinition.signals) {
    // oxlint-disable-next-line unthrown/no-throw -- sanctioned ContractMisuseError model: non-retryable ApplicationFailure Temporal must see thrown (CLAUDE.md rule 2 exception)
    throw new ContractMisuseError(
      `Signal "${signalName}" cannot be defined: workflow "${workflowName}" has no signals in its contract`,
    );
  }
  const signalDef = (workflowDefinition.signals as Record<string, SignalDefinition>)[signalName];
  if (!signalDef) {
    // oxlint-disable-next-line unthrown/no-throw -- sanctioned ContractMisuseError model: non-retryable ApplicationFailure Temporal must see thrown (CLAUDE.md rule 2 exception)
    throw new ContractMisuseError(
      `Signal "${signalName}" not found in workflow "${workflowName}" contract`,
    );
  }

  const signal = defineSignal(signalName);
  setHandler(signal, async (...args: unknown[]) => {
    const input = extractHandlerInput(args);
    const inputResult = await signalDef.input["~standard"].validate(input);
    if (inputResult.issues) {
      // Drop-and-log policy (fire-and-forget semantics): an invalid payload
      // must not fail the execution. `log.warn` is replay-aware, so the
      // warning is emitted once, not on every replay.
      log.warn(
        `Dropped signal "${signalName}": input validation failed: ${summarizeIssues(inputResult.issues)}`,
      );
      return;
    }
    await handler(inputResult.value);
  });
}

/**
 * Bind a typed query handler to the running workflow. Parses the input
 * (receive side of the boundary — the client validated but transmitted
 * the caller's original value) and validates the output, returning the
 * handler's ORIGINAL return value to Temporal — the client parses the
 * query result on receive, so a transforming output schema applies
 * exactly once. Both run synchronously.
 *
 * Temporal's query API requires a synchronous handler — async
 * validation breaks replay determinism. The handler trips a clear
 * {@link ContractMisuseError} if the schema library returns a Promise from
 * `validate(...)`, instead of letting the async path silently corrupt query
 * semantics.
 */
export function bindQueryHandler(
  workflowDefinition: AnyWorkflowDefinition,
  workflowName: string,
  queryName: string,
  handler: QueryHandlerImplementation<QueryDefinition>,
): void {
  if (!workflowDefinition.queries) {
    // oxlint-disable-next-line unthrown/no-throw -- sanctioned ContractMisuseError model: non-retryable ApplicationFailure Temporal must see thrown (CLAUDE.md rule 2 exception)
    throw new ContractMisuseError(
      `Query "${queryName}" cannot be defined: workflow "${workflowName}" has no queries in its contract`,
    );
  }
  const queryDef = (workflowDefinition.queries as Record<string, QueryDefinition>)[queryName];
  if (!queryDef) {
    // oxlint-disable-next-line unthrown/no-throw -- sanctioned ContractMisuseError model: non-retryable ApplicationFailure Temporal must see thrown (CLAUDE.md rule 2 exception)
    throw new ContractMisuseError(
      `Query "${queryName}" not found in workflow "${workflowName}" contract`,
    );
  }

  // Bind-time probe: both query schema slots must validate synchronously.
  // Failing here (worker startup / first workflow task) beats failing on the
  // first live query. The per-call guards below stay as defense-in-depth.
  assertSyncSchema(queryDef.input, {
    workflowName,
    handlerKind: "Query",
    handlerName: queryName,
    direction: "input",
  });
  assertSyncSchema(queryDef.output, {
    workflowName,
    handlerKind: "Query",
    handlerName: queryName,
    direction: "output",
  });

  const query = defineQuery(queryName);
  setHandler(query, (...args: unknown[]) => {
    const input = extractHandlerInput(args);
    const inputResult = queryDef.input["~standard"].validate(input);

    if (inputResult instanceof Promise) {
      // oxlint-disable-next-line unthrown/no-throw -- sanctioned ContractMisuseError model: non-retryable ApplicationFailure Temporal must see thrown (CLAUDE.md rule 2 exception)
      throw new ContractMisuseError(
        `Query "${queryName}" validation must be synchronous. Use a schema library that supports synchronous validation for queries.`,
      );
    }
    if (inputResult.issues) {
      // oxlint-disable-next-line unthrown/no-throw -- sanctioned ValidationError/ApplicationFailure model: terminal failure Temporal must see thrown (CLAUDE.md rule 2 exception)
      throw new QueryInputValidationError(queryName, inputResult.issues);
    }

    const result = handler(inputResult.value);

    const outputResult = queryDef.output["~standard"].validate(result);
    if (outputResult instanceof Promise) {
      // oxlint-disable-next-line unthrown/no-throw -- sanctioned ContractMisuseError model: non-retryable ApplicationFailure Temporal must see thrown (CLAUDE.md rule 2 exception)
      throw new ContractMisuseError(
        `Query "${queryName}" output validation must be synchronous. Use a schema library that supports synchronous validation for queries.`,
      );
    }
    if (outputResult.issues) {
      // oxlint-disable-next-line unthrown/no-throw -- sanctioned ValidationError/ApplicationFailure model: terminal failure Temporal must see thrown (CLAUDE.md rule 2 exception)
      throw new QueryOutputValidationError(queryName, outputResult.issues);
    }

    // Validated, but the handler's ORIGINAL return goes over the wire —
    // the client parses the query result on receive (D1).
    return result;
  });
}

/**
 * Bind a typed update handler to the running workflow.
 *
 * Input validation runs in Temporal's `validator` slot — a synchronous
 * pre-admission hook. If it throws, Temporal rejects the update *before*
 * appending a workflow history event: clients see
 * `WorkflowUpdateValidationRejectedError` and the workflow's history is
 * unaffected. This is the documented contract for `setHandler`'s
 * `validator` option, and it is strictly better than running validation
 * inside the handler body — which forces Temporal to admit the update,
 * write a history event, and surface a `WorkflowUpdateFailedError` to
 * the client only after the fact.
 *
 * Because the validator slot is synchronous, the input schema must also
 * validate synchronously. Standard Schema is allowed to be async (Zod's
 * `.refine(async)` is the typical case), but we trip a clear
 * {@link ContractMisuseError} when that happens rather than silently
 * breaking admission semantics — same approach as `bindQueryHandler`.
 * Users who need async input checks should run them inside the handler
 * body and accept the post-admission failure mode, or restructure their
 * schema.
 *
 * Output validation continues to run inside the handler body. Update
 * outputs are *not* admission-gated — the handler must execute to
 * produce a value to validate against — so the async-allowed shape is
 * preserved. As with every payload boundary, the handler's ORIGINAL
 * return value is what crosses the wire: the client parses the update
 * result on receive, so a transforming output schema applies exactly
 * once.
 */
export function bindUpdateHandler(
  workflowDefinition: AnyWorkflowDefinition,
  workflowName: string,
  updateName: string,
  handler: UpdateHandlerImplementation<UpdateDefinition>,
): void {
  if (!workflowDefinition.updates) {
    // oxlint-disable-next-line unthrown/no-throw -- sanctioned ContractMisuseError model: non-retryable ApplicationFailure Temporal must see thrown (CLAUDE.md rule 2 exception)
    throw new ContractMisuseError(
      `Update "${updateName}" cannot be defined: workflow "${workflowName}" has no updates in its contract`,
    );
  }
  const updateDef = (workflowDefinition.updates as Record<string, UpdateDefinition>)[updateName];
  if (!updateDef) {
    // oxlint-disable-next-line unthrown/no-throw -- sanctioned ContractMisuseError model: non-retryable ApplicationFailure Temporal must see thrown (CLAUDE.md rule 2 exception)
    throw new ContractMisuseError(
      `Update "${updateName}" not found in workflow "${workflowName}" contract`,
    );
  }

  // Bind-time probe: the update *input* schema feeds Temporal's synchronous
  // validator slot, so it must validate synchronously. (The output schema is
  // exempt — it runs inside the async handler body.) The per-call guards
  // below stay as defense-in-depth.
  assertSyncSchema(updateDef.input, {
    workflowName,
    handlerKind: "Update",
    handlerName: updateName,
    direction: "input",
  });

  const update = defineUpdate(updateName);
  setHandler(
    update,
    async (...args: unknown[]) => {
      // The validator already accepted the payload (its parsed value is
      // discarded — it only gates admission). This is the boundary's single
      // receive-side parse: it always starts from the raw wire payload, so
      // the handler receives the schema's transformed value (Standard
      // Schema may rewrite shapes during validation, e.g. Zod `.transform`)
      // with the transform applied exactly once. It is sync because the
      // validator already proved the schema is sync; any async result here
      // would mean the schema changed under us, which is a programmer error
      // worth surfacing.
      const input = extractHandlerInput(args);
      const inputResult = updateDef.input["~standard"].validate(input);
      if (inputResult instanceof Promise) {
        // oxlint-disable-next-line unthrown/no-throw -- sanctioned ContractMisuseError model: non-retryable ApplicationFailure Temporal must see thrown (CLAUDE.md rule 2 exception)
        throw new ContractMisuseError(updateInputMustBeSynchronousMessage(updateName));
      }
      if (inputResult.issues) {
        // The validator should have caught this; if we reach here, the
        // schema produced different issues on a second call (non-pure
        // validator). Surface it as the same typed error class for
        // consistency.
        // oxlint-disable-next-line unthrown/no-throw -- sanctioned ValidationError/ApplicationFailure model: terminal failure Temporal must see thrown (CLAUDE.md rule 2 exception)
        throw new UpdateInputValidationError(updateName, inputResult.issues);
      }

      const result = await handler(inputResult.value);

      const outputResult = await updateDef.output["~standard"].validate(result);
      if (outputResult.issues) {
        // oxlint-disable-next-line unthrown/no-throw -- sanctioned ValidationError/ApplicationFailure model: terminal failure Temporal must see thrown (CLAUDE.md rule 2 exception)
        throw new UpdateOutputValidationError(updateName, outputResult.issues);
      }

      // Validated, but the handler's ORIGINAL return goes over the wire —
      // the client parses the update result on receive (D1).
      return result;
    },
    {
      validator: (...args: unknown[]) => {
        const input = extractHandlerInput(args);
        const inputResult = updateDef.input["~standard"].validate(input);

        if (inputResult instanceof Promise) {
          // oxlint-disable-next-line unthrown/no-throw -- sanctioned ContractMisuseError model: non-retryable ApplicationFailure Temporal must see thrown (CLAUDE.md rule 2 exception)
          throw new ContractMisuseError(updateInputMustBeSynchronousMessage(updateName));
        }
        if (inputResult.issues) {
          // oxlint-disable-next-line unthrown/no-throw -- sanctioned ValidationError/ApplicationFailure model: terminal failure Temporal must see thrown (CLAUDE.md rule 2 exception)
          throw new UpdateInputValidationError(updateName, inputResult.issues);
        }
      },
    },
  );
}
