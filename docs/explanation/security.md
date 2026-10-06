# Security

What temporal-contract puts in Temporal history, what a payload codec does and
does not protect, and why validation messages are redacted.

## Two kinds of data in history

Temporal records every execution's history on the server, where it is readable
through the Web UI, the CLI, and anything with namespace access. Everything in
it falls into one of two categories:

| Category     | Examples                                                                                                                                | Encrypted by a `PayloadCodec`? |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| **Payloads** | workflow / activity / child `args` and results, signal / query / update inputs and results, memo, `ApplicationFailure.details`          | Yes                            |
| **Metadata** | workflow ID, workflow type, activity type, task queue, signal / update names, search attributes, failure `type`, `message`, stack trace | No                             |

Payloads go through the data converter, so a codec configured on the client
and the worker encrypts them before they leave the process. Metadata does not:
the server has to read it to route tasks, match handlers, and answer
visibility queries. Failure `message` and stack trace are the one exception
you can opt into — Temporal's `DefaultFailureConverter` moves them into an
encoded payload when constructed with `encodeCommonAttributes: true`:

```typescript
// failure-converter.ts
import { DefaultFailureConverter } from "@temporalio/common";

export const failureConverter = new DefaultFailureConverter({ encodeCommonAttributes: true });
```

```typescript
import { fileURLToPath } from "node:url";

const dataConverter = {
  payloadCodecs: [encryptionCodec],
  failureConverterPath: fileURLToPath(new URL("./failure-converter.js", import.meta.url)),
};

new Client({ connection, dataConverter }); // then TypedClient.create({ client })
await TypedWorker.create({ contract, connection, workflowsPath, dataConverter }).get();
```

`TypedWorker.create` forwards every Temporal `WorkerOptions` field it does not
own, `dataConverter` included; `TypedClient` wraps a `Client` you construct
yourself. Without a codec, _everything_ in the table is plaintext.

## Where temporal-contract writes

The library adds no data of its own to history beyond what the two categories
above already carry, but it decides what goes into a failure:

- **Validation failures** (`WorkflowInputValidationError`,
  `ActivityOutputValidationError`, … — every `ValidationError`) put only the
  failing field paths in `message`, via `summarizeIssues`:
  `at email; at items[0].qty; …and 3 more`. The full issues, schema messages
  included, ride `details[0]` as `{ message, path }` records — a payload, so
  a codec encrypts them. In process, the raw issues stay on the error's
  `issues` property.
- **Declared contract errors** become an `ApplicationFailure` whose `type` is
  the error name, whose `details[0]` is the `data` payload (encrypted with a
  codec), and whose `message` is the per-call `message` or the contract's
  declared default — **metadata**. Keep values out of it: put them in the
  `data` payload (`errors.CardDeclined({ reason })`), never in a
  `{ message }` override that interpolates the card number.
- **Worker logs** follow the same rule. A dropped signal logs the
  `summarizeIssues` paths, and a rehydration miss logs the error name and the
  reason it did not rehydrate — not the payload.

See [Validation boundaries](/explanation/validation-boundaries#what-a-failure-produces)
for the full shape of each failure.

## Why schema messages are excluded

Schema libraries write the offending input into their messages. Valibot
reports `Invalid email: Received "jane@example.com"`; others echo enum values,
string fragments, or whole objects. Before redaction, that text went straight
into `ApplicationFailure.message` — so a malformed request could copy a
customer's email or an access token into history in plaintext, past a codec
that the team believed was protecting every payload.

Dropping the messages and keeping only paths makes the plaintext part of a
validation failure a function of the _schema_, not the _input_. Bounding it to
five paths keeps a huge invalid array from producing a huge message.
`formatIssue`, which renders path **and** message, is still exported for
in-process diagnostics — don't use it to build text that crosses a Temporal
boundary.

## Identifiers are plaintext

Workflow IDs, search attributes, and names are metadata, so no codec ever
covers them. Two contract features feed them directly from your payloads:

**Derived workflow IDs.** `defineWorkflow({ workflowId: (input) => ... })`
computes the ID from the validated input, on the client and in any parent
workflow starting it as a child. `workflowId: ({ email }) => email` publishes
every customer's email in the workflow list, the Web UI, every log line that
names the execution, and every URL that links to it. Derive from an opaque
identifier — an order ID, a UUID minted upstream and carried in the input —
never from personal data or secrets.

**Search attributes.** Declared search attributes are indexed so the server
can filter on them; they are stored and returned in plaintext by design. Put
a status or a tenant ID there, not a name or an address. See
[Index workflows with search attributes](/how-to/index-workflows-with-search-attributes).

Memo, by contrast, is a payload: the client encodes it through the data
converter, so a codec encrypts it — but nothing can query it.

## Reporting a vulnerability

Report security issues privately, as described in the repository's
[security policy](https://github.com/btravstack/temporal-contract/blob/main/SECURITY.md).

## Next

- [Validation boundaries](/explanation/validation-boundaries) — where schemas
  run and what a failure carries
- [Model domain errors](/how-to/model-domain-errors) — the contract error
  wire format
- [Configure a worker](/how-to/configure-a-worker)
