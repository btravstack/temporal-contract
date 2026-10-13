---
"@temporal-contract/testing": patch
---

`createGlobalSetup` takes a `startupTimeoutMs` budget, three minutes by default, for each container to become healthy. Failed health checks inside the budget no longer count, so `temporalio/auto-setup` can create its schemas on a loaded Docker host, and the budget reaches testcontainers' own startup timeout, which used to stop the wait after 60 seconds. `healthCheckRetries` is deprecated; when `startupTimeoutMs` is unset it is read as the budget in seconds.
