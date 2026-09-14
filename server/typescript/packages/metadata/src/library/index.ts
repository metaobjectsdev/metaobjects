// @metaobjectsdev/metadata/library — the shipped-library surface (FR-043).
//
// The invariant is not "every subpath has an index" — `./constants` is a plain
// `src/constants.ts` and is fine — nor is it "no nesting", since the `paths` `*` matches
// across `/`. It is that the subpath NAME must mirror the layout under `src/`. A subpath
// named `library` substitutes to `src/library`, so the module has to be `src/library.ts`
// or `src/library/index.ts`; it was `src/library/library-sources.ts`, which the
// substitution never reaches. That was not cosmetic: the repo-root
// `tsconfig.scripts.json` maps `@metaobjectsdev/metadata/*` to
// `packages/metadata/src/*` so that `scripts/` typechecks against workspace
// SOURCE rather than a build output. With no `index.ts` here that mapping had
// nothing to land on, so resolution fell through to `node_modules` and found
// `dist/library/library-sources.d.ts` — which exists on a developer's machine
// and does NOT exist on a fresh CI checkout, where the `gates` lane runs
// `bun install` and never builds. The gate was green locally and red on the
// runner for exactly that reason.
//
// So this file is the subpath's entry, and `package.json` names it. Adding a
// module under `library/` means re-exporting it here.
//
// `cli/test/subpath-resolves-under-scripts-paths.test.ts` now gates the whole class,
// across every package the scripts typecheck maps.
export * from "./library-sources.js";
