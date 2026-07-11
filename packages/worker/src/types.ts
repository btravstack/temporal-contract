// The direction-aware schema inference primitives live in
// `@temporal-contract/contract` (single source of truth shared with the
// client package); this module re-exports them so in-package imports and the
// worker's public type surface are unchanged.
export type {
  ClientInferInput,
  ClientInferOutput,
  WorkerInferInput,
  WorkerInferOutput,
} from "@temporal-contract/contract";
