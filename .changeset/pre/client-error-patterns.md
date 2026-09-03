---
"@temporal-contract/client": minor
---

Ready-made error pattern groups — `WORKFLOW_START_PATTERNS`,
`WORKFLOW_RESULT_PATTERNS`, `WORKFLOW_EXECUTE_PATTERNS`,
`WORKFLOW_STOPPED_PATTERNS`, `SIGNAL_PATTERNS`, `QUERY_PATTERNS`,
`UPDATE_PATTERNS`, `SCHEDULE_CREATE_PATTERNS`. Each mirrors one method's error
union exactly, so `matcher.with(...WORKFLOW_RESULT_PATTERNS, handler)` replaces
six hand-written `P.tag(...)` arguments.

Exhaustiveness is unchanged: these are ordinary pattern tuples, so a missing
member is still a compile error naming it. A workflow's **declared contract
errors** are deliberately not in these groups — no shipped group can name a
user's own errors — so for a workflow that declares `errors`, a group alone is
not exhaustive: match those first with `{ errorName: "..." }`.
