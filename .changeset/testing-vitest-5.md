---
"@temporal-contract/testing": minor
---

Accept Vitest 5 alongside Vitest 4: the `vitest` peer range widens from `^4`
to `^4 || ^5`. The fixtures and `globalSetup` hook run unchanged on both; this
repo's own suites now run on Vitest 5.
