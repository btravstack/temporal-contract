---
"@temporal-contract/contract": patch
"@temporal-contract/client": patch
"@temporal-contract/worker": patch
---

Bump `unthrown` to the stable `5.0.0` and raise the peer range to `^5.0.0`.

The only API change since `5.0.0-beta.7` is that the standalone `tag` export is
gone — it now lives on the pattern namespace as `P.tag(t)`, alongside every
other pattern constructor (`P._` / `P.any` / `P.instanceOf` / `P.when` /
`P.union`). The type and runtime behaviour are unchanged: it still produces the
`{ _tag: t }` pattern, still narrows to the matching variant with its payload,
and still works in grouped patterns.

Migration is mechanical — drop `tag` from the import (keeping or adding `P`) and
prefix the call sites:

```diff
- import { tag } from "unthrown";
+ import { P } from "unthrown";

  result.mapErrCases((matcher) =>
-   matcher.with(tag("@temporal-contract/WorkflowFailedError"), (error) => handle(error)),
+   matcher.with(P.tag("@temporal-contract/WorkflowFailedError"), (error) => handle(error)),
  );
```

Every example in the docs, READMEs and TSDoc has been updated to the `P.tag`
spelling, and the upgrade guide gained a note for anyone already tracking an
8.0 beta.
