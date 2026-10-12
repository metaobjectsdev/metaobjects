# @metaobjectsdev/test-generators (private, never published)

This repo's **owned copies** of the ADR-0034 reference generators — the same files
`meta eject` copies into a consumer's `codegen/generators/`, with the template modules they
call (`codegen/templates/` there).

Suites that need a generator set to drive `runGen` import them from here, which means they
exercise the artifact an adopter who EJECTS actually runs. (This package dates from 1.0,
which removed `entityFile` / `queriesFile` / `routesFile` / `barrel` from
`@metaobjectsdev/codegen-ts/generators`; 1.1 restored that import, ADR-0034 Amendment 5.
The package stays, because the owned path is still a supported path and still needs
exercising. The imported path is gated by the byte-identity test in `codegen-ts` and by
`cli/test/integration/stock-generators-importable.test.ts`.)

`cli/test/owned-copies-current.test.ts` byte-compares each copy against what `meta eject`
writes today, so a drifted copy fails loudly. The layout is an adopter's: the generators in
`src/generators/` and the template modules they call, which `meta eject` copies with a
generator (ADR-0034 Amendment 8), in `src/templates/`. Refresh both from the repository root
with:

```
bun scripts/sync-owned-template-copies.ts
```
