# FR5e — Database-source loader errors

**Status:** Schema reserved + cross-port envelope shape locked (2026-05-27). Awaiting a real database-source loader.
**Date:** 2026-05-25 (sketched), 2026-05-27 (design questions resolved + per-port shape tests added)
**Scope:** Java first (FR-003 ships the OMDB persistence engine), then any port that gains database-sourced metadata loading.
**Depends on:** [ADR-0009](../../../spec/decisions/ADR-0009-loader-error-envelope-and-source-on-node.md) (the `format: "database"` slot was always reserved).

## What's shipped

The envelope schema is fully locked across all four ports:

| Port    | Source type                | Location |
|---------|----------------------------|----------|
| TS      | `format: "database"; dbLocation: { table, id }; jsonPath?` | `server/typescript/packages/metadata/src/source.ts` |
| Java    | `record DatabaseSource(DbLocation dbLocation, String jsonPath)` + `record DbLocation(String table, String id)` | `server/java/metadata/src/main/java/com/metaobjects/source/` |
| C#      | `sealed record DatabaseSource(DbLocation DbLocation, string? JsonPath)` + `sealed record DbLocation(string Table, string Id)` | `server/csharp/MetaObjects/Source/ErrorSource.cs` |
| Python  | `@dataclass(frozen=True) DatabaseSource(db_location, json_path)` + `@dataclass(frozen=True) DbLocation(table, id)` | `server/python/src/metaobjects/source/error_source.py` |

Per-port shape tests pin the envelope:

- TS: `server/typescript/packages/metadata/test/source.test.ts` — `describe("ErrorSource — database variant (FR5e schema lock)")`
- Java: `server/java/metadata/src/test/java/com/metaobjects/source/DatabaseSourceShapeTest.java`
- C#: `server/csharp/MetaObjects.Conformance.Tests/Fr5eDatabaseSourceShapeTests.cs`
- Python: `server/python/tests/source/test_fr5e_database_source_shape.py`

A future database-source loader (FR-003 deliberately did NOT ship one — OMDB persists *user data*, not *metamodel*) has a guaranteed-correct envelope target.

## Goal

When metadata is loaded from a database (instead of files), error envelopes report the database location of the offending record:

```jsonc
{
  "code": "ERR_BAD_ATTR_VALUE",
  "message": "field 'priceCents' has invalid @currency value",
  "source": {
    "format": "database",
    "dbLocation": {
      "table": "metaobjects_field_attr",
      "id": "fld_abc123/currency"
    },
    "jsonPath": "$.metadata.root.children[0].field.currency.@currency"
  }
}
```

## Design lock (resolved 2026-05-27)

The three open questions from the original sketch are settled:

1. **`dbLocation` shape: `{ table: string, id: string }` — locked.**
   Composite primary keys are encoded into `id` as a single delimited string
   (e.g. `"fld_abc123/currency"` — row id + attr name joined with `/`). Reasons:
   - Keeps the envelope dialect-neutral. Composite-key schemas vary by RDBMS;
     a richer `dbLocation` shape would bake one schema into the envelope.
   - Matches the pattern that JSON pointers / JSONPath already use for
     nested addressing.
   - Future loaders can pick the delimiter convention; the envelope just
     records the string.

2. **Relationship between `dbLocation` and `jsonPath`: `jsonPath` is OPTIONAL.**
   When metadata is database-sourced, the JSONPath is a derived projection
   over the row's payload. `dbLocation` is the primary locator; `jsonPath`
   adds precision when the offending node is nested within a row's
   payload (e.g. inside a JSONB blob of attributes).

3. **Mixed-source metadata: NOT NEEDED in the envelope.**
   Each error carries the source format of the offending node, not the
   overall load. A mixed file+database load just produces errors with the
   appropriate per-error `format`. No `format: "mixed"` variant required.

## Out of scope

- The OMDB metadata-table schema itself (which tables hold which metadata
  rows) — that's a separate FR when a real database-source loader is built.
- The relationship between database-sourced and file-sourced metadata
  overlay/merge — same.
- A reference database-source loader implementation — also separate.

## Implementing the loader (future, separate FR)

When a database-source loader is built, the implementer must:

1. Emit `DatabaseSource` envelopes from every error / warning path.
2. Use the existing parser/super-resolution/validation pipeline (same as the
   file-source loaders).
3. Add a conformance fixture under `fixtures/conformance/` that exercises a
   `format: "database"` error end-to-end (will require a synthetic test loader
   or an in-memory schema for the metaobjects tables).
4. Decide overlay semantics with file-source metadata (will require a
   separate ADR — this is a real cross-language decision).
