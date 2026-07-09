---
"@temporal-contract/contract": minor
"@temporal-contract/client": minor
"@temporal-contract/worker": minor
---

Upgrade the `unthrown` peer dependency to `^4` (from `^3`).

unthrown 4 is not compatible with unthrown 3 — most notably, `TaggedError`
now reserves `name` and `message` as payload fields (they are set via
`Error`, not passed as structured data). The client and worker error classes
were migrated accordingly; their public shape is unchanged (`_tag`, `name`,
`message`, and the typed payload fields are all still present and behave
identically). Consumers must be on `unthrown@4`.

Released as a minor rather than a major: these packages have no external
consumers pinned to `unthrown@3`, so the peer-range change carries no
real-world break. If you depend on `@temporal-contract/{contract,client,worker}`,
bump `unthrown` to `^4` alongside this release.
