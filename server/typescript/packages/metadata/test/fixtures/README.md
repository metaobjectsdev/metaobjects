# Test fixtures

These JSON files are **canonical conformance fixtures** sourced from the Java metaobjects-core implementation. They exist here as local copies to support round-trip parity testing of the TypeScript port (`@metaobjectsdev/metadata`).

## Source of truth

| Fixture | Origin |
|---|---|
| `fruitbasket-metadata.json` | `metaobjects-core/metadata/src/test/resources/com/metaobjects/loader/simple/fruitbasket-metadata.json` |
| `fruitbasket-proxy-metadata.json` | `metaobjects-core/metadata/src/test/resources/com/metaobjects/loader/simple/fruitbasket-proxy-metadata.json` |
| `acme-vehicle-metadata.json` | `metaobjects-core/metadata/src/test/resources/com/metaobjects/loader/simple/acme-vehicle-metadata.json` |
| `acme-vehicle-overlay-metadata.json` | `metaobjects-core/metadata/src/test/resources/com/metaobjects/loader/simple/acme-vehicle-overlay-metadata.json` |
| `acme-common-metadata.json` | `metaobjects-core/metadata/src/test/resources/com/metaobjects/loader/simple/acme-common-metadata.json` |
| `valid-complete-metadata.json` | `metaobjects-core/codegen-base/src/test/resources/schema-validation/valid-complete-metadata.json` |

**Java is canonical.** If a fixture diverges between the Java tree and this directory, the Java version wins — the TS port should be updated, not the fixture.

## Why these are duplicated (for now)

These should ultimately be **shared** between Java and TS implementations rather than duplicated. The plan: when `metaobjects-core` is restructured to polyglot layout (per [North Star v4 §6](../../../../docs/strategy/2026-05-09-northstar-v4.md)) — `/java/`, `/typescript/`, `/python/`, `/csharp/` subdirectories — the fixtures move to a shared `/test/resources/fixtures/` at the repo root and every language implementation references them from there. That restructure is gated on v0.2 (this work) shipping.

Until then: these are local copies. Tracked in v4 [§9 open questions](../../../../docs/strategy/2026-05-09-northstar-v4.md#9-open-questions) and CLAUDE.md memory hooks.

## How to refresh

If Java's fixtures change before the polyglot restructure lands:

```bash
# from this directory
cp <repo-root>/server/java/metadata/src/test/resources/com/metaobjects/loader/simple/fruitbasket-metadata.json .
cp <repo-root>/server/java/metadata/src/test/resources/com/metaobjects/loader/simple/fruitbasket-proxy-metadata.json .
cp <repo-root>/server/java/metadata/src/test/resources/com/metaobjects/loader/simple/acme-vehicle-metadata.json .
cp <repo-root>/server/java/metadata/src/test/resources/com/metaobjects/loader/simple/acme-vehicle-overlay-metadata.json .
cp <repo-root>/server/java/metadata/src/test/resources/com/metaobjects/loader/simple/acme-common-metadata.json .
cp <repo-root>/server/java/codegen-base/src/test/resources/schema-validation/valid-complete-metadata.json .
```

Then re-run the round-trip tests: `bun test test/round-trip.test.ts`. Any failures point to either a TS port bug or an intentional Java change that the TS port must accommodate.

## Adding new fixtures

Don't add TS-only fixtures here. If you need a new fixture for TS testing:

1. Add it to `metaobjects-core` first (in the appropriate `src/test/resources/` location)
2. Copy the file here
3. Add the row to the table above

This keeps the cross-language conformance story honest. TS-only test data lives elsewhere (e.g., inline in the test file, or a `test/data/` directory not named `fixtures/`).
