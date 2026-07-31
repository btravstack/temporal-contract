# API Documentation

Welcome to the temporal-contract API documentation. This documentation is auto-generated from the source code using TypeDoc.

## Core Packages

- [@temporal-contract/contract](./contract/) - Core contract definitions
- [@temporal-contract/client](./client/) - Type-safe Temporal client
- [@temporal-contract/worker](./worker/) - Type-safe Temporal worker

The `Result` / `AsyncResult` types used throughout the API surface come from
[`unthrown`](https://github.com/btravstack/unthrown). See
[The result model](/explanation/the-result-model) for how the three channels map
onto Temporal's boundaries, and
[Migrate from neverthrow](/how-to/migrate-from-neverthrow) if you are upgrading
from the previous `neverthrow`-based version.

## Testing

- [@temporal-contract/testing](./testing/) - Testing utilities with testcontainers

Each package is documented per **public entry point**: contract as `index`
(the root) and `errors`; worker as `activity`, `worker`, and `workflow`; testing
as `activity`, `contract`, `extension`, `global-setup`, and `time-skipping`. The
internal `@temporal-contract/contract/internal` entry carries no semver
guarantee and is intentionally excluded.

## Hand-written reference

The generated pages above describe every symbol exported from those public
entry points. For grouped, narrative reference — option tables, error channels,
merge order — see:

- [Contract surface](/reference/contract-surface)
- [Worker surface](/reference/worker-surface)
- [Client surface](/reference/client-surface)
- [Testing surface](/reference/testing-surface)
- [Errors](/reference/errors)
- [Glossary](/reference/glossary)
