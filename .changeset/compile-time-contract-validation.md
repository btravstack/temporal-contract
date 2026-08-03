---
"@temporal-contract/contract": major
---

`defineContract` now validates contracts at compile time, in addition to runtime — nothing is removed, and every runtime check still throws exactly as before. The compile-time layer is a strictly narrower, strictly more permissive mirror of it: it only catches what it can prove without ambiguity, and a compile error surfaces as a "not assignable" diagnostic on the offending property.

Caught at compile time:

- **Reserved Temporal names.** A workflow, activity, global activity, signal, query, or update named `__temporal_*`, `__stack_trace`, or `__enhanced_stack_trace` now fails to type-check. Error names and search-attribute names are unaffected, matching the runtime, which exempts them deliberately.
- **Malformed `ms` durations.** The four `activityOptions` timeout slots (`startToCloseTimeout`, `scheduleToCloseTimeout`, `scheduleToStartTimeout`, `heartbeatTimeout`) and the two retry intervals (`retry.initialInterval`, `retry.maximumInterval`) are checked against the `ms` grammar, both when written inline in `defineContract` and when set via a separate `defineActivity`.
- **Flat-namespace activity collisions.** One activity name bound to structurally different definitions across scopes, and a workflow name shadowed by a global activity, both now fail to type-check. Sharing one `defineActivity` result across scopes still compiles, as before — only genuinely conflicting definitions are flagged.

A duration whose value is a computed `string` rather than a literal (read from config, built dynamically, etc.) cannot be checked at compile time — there is no literal to inspect. The runtime still validates it at `defineContract` time, exactly as it always has.

**Breaking:** `defineContract`'s type parameter is now `const`. This preserves literal types through inference and infers array properties as `readonly` tuples instead of mutable arrays. It also makes the returned contract's own properties `readonly` (`c.taskQueue = "x"` and `c.workflows = …`, which compiled before, are now errors) and infers string properties as literals rather than `string` (`(typeof c)["taskQueue"]` was `string`, is now e.g. `"orders"`). Code that assigns a contract literal to a variable typed for mutation, mutates a contract's top-level properties, or relies on a widened `string` type for `taskQueue` or similar fields may need adjustment.

**Breaking:** `DurationValue` changed from `string | number` to `` `${number}${string}` | number | (string & {}) ``. Every value the runtime accepts still type-checks, including computed `string`s — but code that reads the type directly (e.g. `Extract<DurationValue, string>`) may see a different shape than before.

**Known limitation:** a contract assembled inside a generic helper (a contract-factory or multi-tenant-builder pattern, with a generic `workflows` map or a generic `activities` map) now fails to type-check, reported as an unreadable "not assignable" error on a raw conditional type. TypeScript cannot check a generic argument against `defineContract`'s computed parameter type. The runtime still accepts and validates these contracts exactly as before. Workaround — make the whole contract generic instead of a piece of it:

```typescript
function makeContract<T extends ContractDefinition>(contract: T) {
  return defineContract(contract);
}
```
