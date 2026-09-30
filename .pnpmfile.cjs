// typedoc and rolldown-plugin-dts (tsdown's `--dts`) drive the TypeScript JS
// compiler API, which TypeScript 7 (the Go port) no longer ships: its
// `typescript` package is the native `tsc` plus a version stub. Swap their
// `typescript` peer for a regular dependency on `@typescript/typescript6` (the
// TS 6 API, published for side-by-side use) while the packages type-check with
// TS 7's `tsc`.
//
// - typedoc crashes outright on TS 7.
// - rolldown-plugin-dts falls back to spawning TS 7's `tsc` with `--rootDir`
//   forced to the tsconfig's directory, overriding packages/testing's
//   `"rootDir": ".."`; tsc then writes declarations for the sibling sources
//   that testing pulls in through `paths` straight into their `src/`.
//
// Remove an entry once that tool supports TypeScript 7.
const TS6_API = new Set(["typedoc", "rolldown-plugin-dts"]);

module.exports = {
  hooks: {
    readPackage(pkg) {
      if (TS6_API.has(pkg.name)) {
        delete pkg.peerDependencies.typescript;
        delete pkg.peerDependenciesMeta?.typescript;
        pkg.dependencies = { ...pkg.dependencies, typescript: "npm:@typescript/typescript6@6.0.2" };
      }
      return pkg;
    },
  },
};
