---
"@temporal-contract/worker": minor
---

Add the `qualify(type, options?)` helper to `@temporal-contract/worker/activity`.

It builds the qualifier function `fromPromise` needs, replacing the
`ApplicationFailure.create({ type, message: error instanceof Error ? ... })`
boilerplate previously repeated in every activity:

```ts
import { declareActivitiesHandler, qualify } from "@temporal-contract/worker/activity";
import { fromPromise } from "unthrown";

export const activities = declareActivitiesHandler({
  contract,
  activities: {
    sendEmail: (args) =>
      fromPromise(emailService.send(args), qualify("EMAIL_SEND_FAILED")).map(() => ({
        sent: true,
      })),
  },
});
```

An `Error` rejection keeps its own message and is preserved as `cause`;
non-`Error` rejections fall back to `options.message` (or `String(error)`).
`options.nonRetryable` and `options.details` are forwarded to the failure.
The qualifier always wraps — even an `ApplicationFailure` rejection — so the
declared `type` is guaranteed for retry policies.
