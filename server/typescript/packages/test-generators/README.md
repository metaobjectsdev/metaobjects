# @metaobjectsdev/test-generators (private, never published)

This repo's **owned copies** of the ADR-0034 reference generators — the same files
`meta init` scaffolds into a consumer's `codegen/generators/`.

1.0 removes `entityFile` / `queriesFile` / `routesFile` / `barrel` from
`@metaobjectsdev/codegen-ts/generators` (readiness G2 / ADR-0035 A3). Suites that need a
generator set to drive `runGen` import them from here instead, which means they exercise
the artifact an adopter actually runs rather than an engine internal.

`test/owned-copies-current.test.ts` byte-compares each copy against
`readReferenceTemplate(name)`, so a drifted copy fails loudly. Refresh with:

```
cp ../codegen-ts/src/reference/{entity,queries,routes,barrel}.ts src/
```
