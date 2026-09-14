// @metaobjectsdev/metadata/vocabulary-rewrite-yaml — the YAML arm of `meta upgrade`.
//
// The implementation stays under `core/`, beside the canonical-JSON rewriter it mirrors.
// This file exists so the SUBPATH NAME mirrors the layout under `src/`, which is what
// `tsconfig.scripts.json`'s `@metaobjectsdev/metadata/*` → `src/*` mapping requires.
//
// Nesting is NOT the problem — the `*` matches across `/`, which is why
// `@metaobjectsdev/codegen-ts/templates/entity-file` resolves to
// `src/templates/entity-file.ts` perfectly well. The problem was a subpath NAMED
// `vocabulary-rewrite-yaml` whose source sat at `src/core/vocabulary-rewrite-yaml.ts`:
// the substitution yields `src/vocabulary-rewrite-yaml`, and that is not where the module
// is. Renaming the export to `./core/vocabulary-rewrite-yaml` would also have satisfied
// the rule and was the cheaper edit, but this package is published and that subpath is
// public API, so the name stays and the layout moves to meet it.
//
// When the mapping misses, tsc falls through to `node_modules` and reads `dist/` — present
// for anyone who has built, absent on a fresh CI checkout where the `gates` lane runs
// `bun install` and never builds. `./library` shipped that way and took the lane down;
// this one had not been imported from anywhere `scripts/` typechecks, so it was latent.
// `cli/test/subpath-resolves-under-scripts-paths.test.ts` now gates the class.
export { rewriteYamlDocument, type YamlRewriteResult } from "./core/vocabulary-rewrite-yaml.js";
