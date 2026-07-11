---
"@temporal-contract/contract": patch
"@temporal-contract/worker": patch
"@temporal-contract/client": patch
---

Require unthrown >= 4.1.0 (peer range `^4` → `^4.1.0`).

unthrown 4.1 renames several operators and deprecates the old aliases (`orElse` → `flatMapErr`, `recover` → `recoverErr`, `unwrap`/`unwrapErr`/`unwrapOr`/`unwrapOrElse` → `get`/`getErr`/`getOr`/`getOrElse`). The packages' own code never used the deprecated names, so no runtime behavior changes — the docs and guides now reference the new names, and raising the peer minimum guarantees the renamed operators exist for consumers following them.
