import { defineConfig } from "vitest/config";

// Dedicated Vitest entry point for Stryker mutation testing (Task 10).
//
// Why this file exists instead of pointing Stryker at an existing package's
// `vitest.config.ts`: the installed `@stryker-mutator/vitest-runner@9.2.0`
// only supports `vitest.configFile` (a single config file) — there is no
// `vitest.project` option to select a named project out of a config, despite
// what earlier planning assumed. Each package's own `vitest.config.ts` mixes
// its "unit" project with "integration"/"integration-inprocess" projects
// that spin up a real (or time-skipping) Temporal test server; pointing
// Stryker at one of those directly would run the sandboxed workflow suites
// for every mutant, which this task explicitly excludes on cost grounds.
//
// This file instead composes just the "unit" projects for the two packages
// that own the mutated files (`packages/contract`, `packages/worker`),
// mirroring their `vitest.config.ts` "unit" project definitions verbatim.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "contract-unit",
          root: "packages/contract",
          include: ["src/**/*.spec.ts"],
          exclude: ["src/**/__tests__/*.spec.ts"],
          setupFiles: ["./src/vitest.setup.ts"],
        },
      },
      {
        test: {
          name: "worker-unit",
          root: "packages/worker",
          include: ["src/**/*.spec.ts"],
          exclude: ["src/**/__tests__/*.spec.ts"],
          setupFiles: ["./src/vitest.setup.ts"],
        },
      },
    ],
  },
});
