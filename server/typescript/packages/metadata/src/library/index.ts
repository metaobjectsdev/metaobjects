// @metaobjectsdev/metadata/library — the shipped-library surface (FR-043).
//
// Every other subpath of this package resolves through a directory `index.ts`
// (`/core`, and the root entry itself). This one pointed straight at
// `library-sources.ts`, and that inconsistency was not cosmetic: the repo-root
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
export * from "./library-sources.js";
