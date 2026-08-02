/**
 * `testRig`'s `replaySkipAllowlist` for `handlers.inprocess.spec.ts` —
 * workflow-ID prefixes whose executions are deliberately left non-terminal,
 * so their histories cannot be replayed. Every entry needs a reason.
 *
 * `@temporal-contract/testing/test-rig` no longer bakes fixture IDs from this
 * repo into the published rig (an external consumer's workflow IDs could
 * collide with them and be silently skipped) — `replaySkipAllowlist` is a
 * caller-supplied `RigOptions` field instead, defaulting to `{}`. This is
 * that caller's list, kept as a fixture next to the spec that owns the
 * workflows it names; it is not exported from the package.
 *
 * This list may only ever shrink. A silently-skipped execution would report
 * replay coverage it does not have — exactly the rot `testRig` exists to
 * prevent — so an unlisted non-terminal execution fails the test instead.
 */
export const HANDLERS_REPLAY_SKIP_ALLOWLIST: Readonly<Record<string, string>> = {
  "handlers-probe-edge-cases":
    "handlers.workflows.ts's probeEdgeCases blocks on condition(() => false) and is never " +
    "signaled to finish — the spec only issues queries against it, so its execution is " +
    "deliberately left running forever.",
  // Three exact IDs (not a shared prefix): each is a static literal, not
  // counter-suffixed, so a narrower key here means a future
  // "handlers-wire-*" workflow that hangs by accident isn't silently
  // swept into this entry too.
  "handlers-wire-signal":
    "handlers.workflows.ts's transformWorkflow blocks on condition(() => false) and is never " +
    "signaled to finish — this spec only signals against it directly, so its execution is " +
    "deliberately left running forever.",
  "handlers-wire-query":
    "handlers.workflows.ts's transformWorkflow blocks on condition(() => false) and is never " +
    "signaled to finish — this spec only queries it directly, so its execution is " +
    "deliberately left running forever.",
  "handlers-wire-update":
    "handlers.workflows.ts's transformWorkflow blocks on condition(() => false) and is never " +
    "signaled to finish — this spec only updates it directly, so its execution is " +
    "deliberately left running forever.",
};
