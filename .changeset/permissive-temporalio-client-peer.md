---
"@temporal-contract/client": patch
---

Loosen the `@temporalio/client` peer dependency range from `^1.16.0` back to `^1`.

The `^1.16.0` floor was set because `client.schedule` (the Schedule API) only exists in `@temporalio/client` 1.16+. But `TypedClient`'s constructor already fails fast with a clear ">= 1.16" error if a consumer reaches for the Schedule API on an older version, so the stricter install-time range was redundant. Widening it back to `^1` keeps the package permissive about the installed Temporal version — consumers on 1.0–1.15 who never touch schedules no longer get a spurious peer-dependency warning — while the runtime guard still protects anyone who does. This also realigns the client peer range with `@temporalio/common` (`^1`) and the worker package.
