---
"@temporal-contract/contract": patch
"@temporal-contract/client": patch
"@temporal-contract/worker": patch
"@temporal-contract/testing": patch
---

Bump `unthrown` to `5.1.0` in the workspace catalog.

No consumer-visible change: the peer range stays `^5.0.0`, which already
admitted `5.1.0`, so nothing about the installed graph changes for anyone
depending on these packages. Only the repo's own dev dependency moves.

`5.1.0`'s public export surface is identical to `5.0.0`'s — 32 top-level
exports, none added, none removed (compared by extracting the declarations from
both packages' `dist/index.d.mts`). Verified against the full suite: typecheck
12/12, unit 9/9, the in-process tier on a real time-skipping server (14 files /
71 tests), and the testing package's own 52.
