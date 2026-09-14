// @metaobjectsdev/metadata/vocabulary-rewrite-yaml — the YAML arm of `meta upgrade`.
//
// The implementation stays under `core/`, beside the canonical-JSON rewriter it mirrors.
// This file exists so the SUBPATH has something to resolve to: `tsconfig.scripts.json`
// maps `@metaobjectsdev/metadata/*` to `src/*`, and a subpath declared as
// `src/core/vocabulary-rewrite-yaml.ts` is a directory deeper than that substitution can
// reach. Without an entry here, tsc misses, falls through to `node_modules`, and reads
// `dist/` — which exists on a machine that has built and not on a fresh CI checkout, where
// the `gates` lane runs `bun install` and never builds.
//
// `./library` shipped in exactly that state and took the lane down; this one had not been
// imported from anywhere `scripts/` typechecks yet, so it was latent rather than red.
// `cli/test/subpath-resolves-under-scripts-paths.test.ts` now gates the class.
export { rewriteYamlDocument, type YamlRewriteResult } from "./core/vocabulary-rewrite-yaml.js";
