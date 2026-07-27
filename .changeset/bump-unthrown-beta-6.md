---
"@temporal-contract/contract": patch
"@temporal-contract/client": patch
"@temporal-contract/worker": patch
---

Bump `unthrown` to `5.0.0-beta.6`, whose exhaustive matcher is now built-in
(same `.with(…)` / `tag` / `P` call-site shape — no code changes needed). The
`ts-pattern` peer/dev dependencies added for beta.5 are removed: `unthrown` has
zero runtime dependencies, so nothing needs installing alongside it. The
`unthrown` peer range is raised to `^5.0.0-beta.6`.
