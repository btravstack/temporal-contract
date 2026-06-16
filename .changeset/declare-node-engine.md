---
"@temporal-contract/contract": minor
"@temporal-contract/worker": minor
"@temporal-contract/client": minor
"@temporal-contract/testing": minor
---

Declare `engines.node: ">=22.19.0"` on every published package. The floor is set by `undici@8` (pulled in transitively by `testcontainers` via `@temporal-contract/testing`), which already fails at runtime on Node ≤22.18 — the engines field just surfaces that reality at install time so consumers get a clear signal instead of a stack trace. Also bumps `@temporalio/*` 1.18.0 → 1.18.1 and `testcontainers` 12.0.1 → 12.0.2 in the catalog.
