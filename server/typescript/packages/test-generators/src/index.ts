// The repo's OWN copies of the ADR-0034 reference templates — the same move `meta init`
// scaffolds into a consumer's `codegen/generators/*.ts`. They exist because 1.0 removes
// `entityFile` / `queriesFile` / `routesFile` / `barrel` from
// `@metaobjectsdev/codegen-ts/generators` (readiness G2, ADR-0035 A3), and the suites that
// drive `runGen` need a generator set. Taking the OWNED copies rather than reaching for an
// engine internal means this repo's tests exercise the artifact an adopter actually runs.
//
// The copies are byte-gated against `readReferenceTemplate()` by `test/owned-copies-current.test.ts`,
// so they cannot drift from the templates `meta init` ships. Refresh with:
//   cp ../codegen-ts/src/reference/{entity,queries,routes,barrel}.ts src/
//
// This package is `private: true` and is never published.
export { entityFile, type EntityFileOpts } from "./entity.js";
export { queriesFile, type QueriesFileOpts } from "./queries.js";
export { routesFile, type RoutesFileOpts } from "./routes.js";
export { barrel, type BarrelOpts } from "./barrel.js";
