# Adding a New Package

Step-by-step checklist for adding a published package under `packages/`. For an example or tool, scope down accordingly.

## 1. Scaffold the directory

```
packages/<name>/
  src/
    index.ts             # main entry
  package.json
  tsconfig.json
  vitest.config.ts       # only if the package has tests
  README.md
```

## 2. `package.json`

Copy from an existing peer (e.g. `packages/contract/package.json`) and adjust:

- `"name": "@temporal-contract/<name>"`
- `"version": "1.0.0"` — initial; changesets bump this.
- `"type": "module"`
- `"exports"` map — declare every subpath you intend to expose. Don't add a root `.` entry unless the package has a single canonical entry; multi-entry packages (like `worker` with `./activity`/`./worker`/`./workflow`) should leave it off so subpath imports are the only valid form.
- `"files": ["dist"]` — only the build output ships.
- `"scripts.build"` uses `tsdown ... --format cjs,esm --dts --clean` matching siblings.
- `"dependencies"` / `"devDependencies"` — reference the catalog (`"catalog:"`) and workspace siblings (`"workspace:*"`).
- **Peer-dep policy:** anything that appears in your public `.d.ts` types must go in `peerDependencies` _and_ `devDependencies`. See [dependencies.md](./dependencies.md).

## 3. `tsconfig.json`

```json
{
  "extends": "@temporal-contract/tsconfig/base.json",
  "include": ["src/**/*"],
  "exclude": ["dist", "node_modules"]
}
```

Inherits the strict-mode + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` flags from `tools/tsconfig/base.json`.

## 4. `vitest.config.ts` (if you have tests)

Copy `packages/worker/vitest.config.ts:1-29` shape:

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    reporters: ["default"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "json-summary", "html"],
      include: ["src/**", "!src/__tests__/**"],
    },
    projects: [
      {
        test: {
          name: "unit",
          include: ["src/**/*.spec.ts"],
          exclude: ["src/**/__tests__/*.spec.ts"],
        },
      },
      {
        test: {
          name: "integration",
          globalSetup: "@temporal-contract/testing/global-setup",
          include: ["src/**/__tests__/*.spec.ts"],
          testTimeout: 10_000,
        },
      },
    ],
  },
});
```

Drop the `integration` project if the package doesn't need a Temporal server. `packages/contract/vitest.config.ts` is the unit-only template.

## 5. Workspace registration

`pnpm-workspace.yaml`'s `packages:` glob already matches `packages/*` — nothing to add there. But you do need:

- **`.changeset/config.json`** — add the package name to the `fixed` array if it should release in lockstep with the others (almost always yes for `@temporal-contract/*` published packages):
  ```json
  "fixed": [["@temporal-contract/contract", "@temporal-contract/worker", "@temporal-contract/client", "@temporal-contract/testing", "@temporal-contract/<new>"]]
  ```
- **`knip.json`** — add an entry if the package has unusual entry points (e.g. test fixtures imported only by integration tests). Most packages need nothing; just ensure they aren't flagged as unused.
- **`docs/scripts/copy-docs.ts`** — if the package generates typedoc output, add it to the `packages` array and the import-for-detection list.
- **`docs/.vitepress/config.ts`** — add the package to the API sidebar if it has user-facing API docs.

## 6. `pnpm install`

Run from the repo root to wire workspace deps. Verify the package shows up:

```bash
pnpm -r ls --depth -1 | grep <name>
```

## 7. Build + typecheck + test

```bash
pnpm --filter @temporal-contract/<name> build
pnpm --filter @temporal-contract/<name> typecheck
pnpm --filter @temporal-contract/<name> test
```

Then run them from the root once to confirm Turbo's `dependsOn: ["^build"]` graph still resolves (`turbo.json:11-15`).

## 8. Changeset

```bash
pnpm changeset
```

Pick the version bump (`major`/`minor`/`patch`) and write a one-paragraph summary. Since the package is in the `fixed` array, all four (now five) packages will bump together.

## 9. Update the rules

If the new package introduces a public concept agents should know about (a new error class, a new helper), add a one-line breadcrumb to the relevant `.agents/rules/*.md`.

## What NOT to do

- **Don't add a root `.` entry to `exports`** unless the package is single-entry. Subpath-only is intentional for multi-entry packages.
- **Don't put `unthrown` (or any other type-bearing dep) in `dependencies`** — peer-dep, see [dependencies.md](./dependencies.md).
- **Don't import from `@temporal-contract/<other>` via relative path.** Use the workspace-resolved package name even for sibling packages.
- **Don't skip the changeset.** CI will pass without one, but the release will skip the package silently. Changesets are the only release mechanism.
