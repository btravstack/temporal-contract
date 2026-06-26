# API Documentation

Welcome to the temporal-contract API documentation. This documentation is auto-generated from the source code using TypeDoc.

## Core Packages

- [@temporal-contract/contract](./contract/) - Core contract definitions
- [@temporal-contract/client](./client/) - Type-safe Temporal client
- [@temporal-contract/worker](./worker/) - Type-safe Temporal worker

The `Result` / `AsyncResult` types used throughout the API surface come from
[`unthrown`](https://github.com/btravstack/unthrown). See
[Migrating from neverthrow](/guide/migrating-to-unthrown) if you are upgrading
from the previous `neverthrow`-based version.

## Testing

- [@temporal-contract/testing](./testing/) - Testing utilities with testcontainers
