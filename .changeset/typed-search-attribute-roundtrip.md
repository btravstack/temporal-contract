---
"@temporal-contract/client": minor
"@temporal-contract/contract": patch
"@temporal-contract/worker": patch
"@temporal-contract/testing": patch
---

Round-trip typed search attributes; reject undeclared keys; surface a typed reader.

**Three improvements to the search-attribute story:**

1. **Schedules now accept typed `searchAttributes`** on `client.schedule.create(...)`. They translate through the same helper as `client.startWorkflow` / `executeWorkflow` and attach to the schedule's `startWorkflow` action so spawned runs are indexed identically to direct starts. Closes a real production gotcha where schedule-spawned workflows silently lost typed indexing.

2. **Undeclared attribute keys are now rejected with `RuntimeClientError`** instead of being silently dropped. The TypeScript surface already gates the happy path; the runtime check catches typed-escape-hatch cases (`as never`, `as any`, raw-call interop) where a typo would otherwise leave the workflow unindexed without any signal to the caller. The error's `operation` is `"searchAttributes"` so callers can branch on it.

3. **New public helper `readTypedSearchAttributes(workflowDef, instance)`** exposed from `@temporal-contract/client` — the read-side counterpart to the write-side `searchAttributes` option. Pass it the result of `handle.describe()` (or a schedule's describe) and recover the typed shape:

   ```ts
   const description = await handle.describe();
   if (description.isOk()) {
     const attrs = readTypedSearchAttributes(
       myContract.workflows.processOrder,
       description.value.typedSearchAttributes,
     );
     // attrs.customerId: string | undefined
     // attrs.priority:   number | undefined
   }
   ```

   The Temporal SDK only exposes `.get(key)` requiring callers to reconstruct each `SearchAttributeKey`; this helper does that lookup once for every declared attribute and returns a `Partial<TypedSearchAttributeMap<TWorkflow>>`.

Internal: `toTypedSearchAttributes` moved from `client.ts` to `internal.ts` so `schedule.ts` can share the implementation. The previous "filters out attribute keys that aren't declared on the workflow at runtime" test was renamed and now asserts the new throw behavior.
