// Merging now happens during parse (parser's intoRoot / createOrFindMetaData
// logic), driven by the per-node `merge: true` flag. Coverage lives in:
//   test/parser-json.test.ts  — per-node merge semantics
//   test/loader.test.ts       — round-trip with acme-vehicle fixtures
//
// This file is a placeholder so no import resolves to a missing module.
