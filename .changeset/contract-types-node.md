---
"@temporal-contract/contract": patch
---

Consume the shared `@btravstack/tsconfig` / `@btravstack/typedoc` published config directly (the local `tools/*` packages are removed). Also add a direct `@types/node` dev dependency to `@temporal-contract/contract` (its siblings already declare it) so `types: ["node"]` still resolves now that the strict TS base comes from `node_modules/@btravstack/tsconfig`.
