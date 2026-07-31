// Registers `@unthrown/vitest`'s custom matchers (`toBeOk`, `toBeOkWith`, `toBeErr`,
// `toBeErrTagged`, `toBeDefect`) on Vitest's `expect`, and brings their
// `declare module "vitest"` type augmentation into the compilation so the
// matchers type-check in the spec files. Referenced from `setupFiles` in
// `vitest.config.ts`; not part of the package's published surface.
import "@unthrown/vitest";
