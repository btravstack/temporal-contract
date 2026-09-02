---
"@temporal-contract/worker": patch
---

Lift the transitive `browserslist` past GHSA-c83g-rgw3-j3cx and
GHSA-73wf-gq98-2v4g (both High) with a workspace override.

It reaches this repository through `examples/order-processing-worker` >
`@temporalio/worker` > `webpack` — the workflow bundler, a dev/build path no
published package carries. There is nothing upstream to take: `@temporalio/worker`
resolves the vulnerable line itself, and `4.28.7` is the first release patching
both advisories. Re-measured after the override: `pnpm audit --audit-level=high`
reports no known vulnerabilities, and the workflow bundle still builds.
