---
"@temporal-contract/worker": major
"@temporal-contract/testing": major
---

The activity leaf takes **helpers first, input second** — `({ errors, context }, args)`
where it was `(args, { errors, context })`.

oRPC is the reference shape for this family, because it is the most widely used
of the three transports a `@btravstack/*` application composes: a developer
arriving here has more likely seen `({ errors, context }, input)` than either of
the others. The mint and compose calls already agreed across the three; the leaf
a developer types by hand did not, and it is the one they relearn per transport.
`@amqp-contract` moves with it.

Every implementation that READS its input fails to compile until it is swapped,
because the first parameter is now the helpers record. One that ignores its
input keeps compiling with a parameter whose name lies — grep the
implementations map for a leaf whose first parameter is not a helpers
destructuring.

`args` is on the helpers record as well as in the second parameter, which is
oRPC's own shape — `ProcedureHandlerOptions` carries `input` and the handler
still takes it positionally — so both spellings are the same call:

```ts
place: ({ errors, args }) => …   // everything off one destructuring
place: ({ errors }, args) => …   // the positional shortcut
place: (_, args) => …            // consumes neither errors nor context
```

`ActivityImplementationFor` / `GlobalActivityImplementationFor` annotations and
`@temporal-contract/testing`'s `runActivity` / `runActivityHandler`
`implementation` option carry the same order.

Closes #414.
