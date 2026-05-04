# API Documentation

Welcome to the temporal-contract API documentation. This documentation is auto-generated from the source code using TypeDoc.

## Core Packages

- [@temporal-contract/contract](./contract/) - Core contract definitions
- [@temporal-contract/client](./client/) - Type-safe Temporal client
- [@temporal-contract/worker](./worker/) - Type-safe Temporal worker

The `Result` / `ResultAsync` types used throughout the API surface come from
[`neverthrow`](https://github.com/supermacro/neverthrow). See
[Migrating to neverthrow](/guide/migrating-to-neverthrow) if you are upgrading
from the previous `@swan-io/boxed`-based version.

## Testing

- [@temporal-contract/testing](./testing/) - Testing utilities with testcontainers
