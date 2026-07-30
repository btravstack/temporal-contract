# Examples

A complete, runnable order-processing application lives in the
[repository](https://github.com/btravstack/temporal-contract/tree/main/examples).

If you are learning, start with [Your first
workflow](/tutorial/your-first-workflow) instead — it builds a smaller version
of the same thing step by step.

## Order processing

Three packages, mirroring how a real deployment splits:

| Package                                                                                                                     | Contents                                                                                                                                                                                                                                                                                          |
| --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`order-processing-contract`](https://github.com/btravstack/temporal-contract/tree/main/examples/order-processing-contract) | The shared contract, built composition-first with the `define*` helpers: signals (payload-carrying and payload-less), an argument-less query, a `PaymentDeclined` typed error shared by activity and workflow, and a schedule-ready, activity-less cleanup workflow. Depended on by the other two |
| [`order-processing-worker`](https://github.com/btravstack/temporal-contract/tree/main/examples/order-processing-worker)     | Clean-architecture worker: `AsyncResult` activities with `qualifyFailure` and typed error constructors, a `condition`-based approval gate with signal/query handlers, an activity-less schedule-driven workflow, and integration tests                                                            |
| [`order-processing-client`](https://github.com/btravstack/temporal-contract/tree/main/examples/order-processing-client)     | `TypedClient.create({ client }).for(contract)` in action: typed signals/queries through handles, the synchronous `getHandle`, exhaustive `match` + `P.tag` including the rehydrated `PaymentDeclined` contract error, and `schedule.create` with the create-if-absent idiom                       |

### What it demonstrates

- **A saga with compensation** — payment succeeds, inventory reservation fails,
  the payment is refunded before returning a failure.
- **Global and workflow-scoped activities** — `sendNotification` is shared;
  payment, inventory, and shipping belong to `processOrder`.
- **Per-activity option overrides** — payment activities get longer timeouts and
  more retries than the workflow default.
- **Hexagonal structure** — the worker separates `domain/` (ports and use cases)
  from `infrastructure/` (adapters), with activities as thin wrappers. Not
  required by the library, but it shows the shape the `createContext` seam
  supports.
- **Replay-safe logging** — `log` from `@temporalio/workflow`, with a note on
  why logging should not be an activity.
- **Cancellation propagation** — the non-critical notification step re-throws
  cancellation rather than swallowing it.
- **Integration tests** — against a real Temporal server via testcontainers.

### Run it

```bash
git clone https://github.com/btravstack/temporal-contract.git
cd temporal-contract
pnpm install
pnpm build

# Terminal 1 — a Temporal dev server
temporal server start-dev

# Terminal 2 — the worker
pnpm --filter @temporal-contract/sample-order-processing-worker dev

# Terminal 3 — the client
pnpm --filter @temporal-contract/sample-order-processing-client dev
```

Watch the execution at <http://localhost:8233>.

### Run its tests

```bash
# Integration tests — needs Docker
pnpm --filter @temporal-contract/sample-order-processing-worker test
```

## Worth reading in the source

| File                                                                                                                                        | Why                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| [`contract.ts`](https://github.com/btravstack/temporal-contract/blob/main/examples/order-processing-contract/src/contract.ts)               | The global vs workflow-scoped activity split                    |
| [`workflows.ts`](https://github.com/btravstack/temporal-contract/blob/main/examples/order-processing-worker/src/application/workflows.ts)   | Compensation logic, cancellation handling, per-activity options |
| [`activities.ts`](https://github.com/btravstack/temporal-contract/blob/main/examples/order-processing-worker/src/application/activities.ts) | The nested implementation map, `fromPromise` + `qualifyFailure` |

## Smaller, focused examples

Each how-to guide is a self-contained recipe:

- [Model domain errors](/how-to/model-domain-errors)
- [Use signals, queries, and updates](/how-to/use-signals-queries-and-updates)
- [Run child workflows](/how-to/run-child-workflows)
- [Handle cancellation](/how-to/handle-cancellation)
- [Schedule workflows](/how-to/schedule-workflows)
- [Test workflows](/how-to/test-workflows)

## Contribute one

Examples covering a pattern not shown here are welcome. See
[CONTRIBUTING.md](https://github.com/btravstack/temporal-contract/blob/main/CONTRIBUTING.md).
