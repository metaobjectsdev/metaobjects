# FR5e — Database-source loader errors (sketch, future)

**Status:** Forward-looking — gated on FR-003 (OMDB persistence engine)
**Date:** 2026-05-25
**Scope:** Java first (FR-003 is the Java OMDB persistence engine), then any port that
gains database-sourced metadata loading.
**Depends on:** [ADR-0009](../../../spec/decisions/ADR-0009-loader-error-envelope-and-source-on-node.md) (the `format: "database"` slot is already reserved), FR-003 (database-loader implementation).

## Goal

When metadata is loaded from a database (instead of files), error envelopes report
the database location of the offending record:

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

## Why this exists now as a sketch

ADR-0009 reserves `format: "database"` in the envelope so the schema is forward-stable.
FR5e is the placeholder for the implementation FR that lands alongside FR-003. No work
happens until FR-003 ships.

## Open design questions (deferred)

All of these wait for FR-003 to settle:

1. **`dbLocation` shape** — is `{ table, id }` enough, or do we need composite keys?
   FR-003's schema dictates this.
2. **Relationship between `dbLocation` and `jsonPath`** — when metadata is database-
   sourced, the JSONPath is a derived projection. Is `jsonPath` optional or required?
3. **Multi-source metadata** — what if a single load aggregates from files + database?
   The envelope discriminator allows it; do consumers need a `format: "mixed"` variant?

## What FR5e WON'T do

- Define the OMDB schema or persistence semantics — that's FR-003.
- Define how database-sourced metadata is overlaid with file-sourced metadata — FR-003
  again.

## Open questions

To be settled during brainstorm when FR-003 nears delivery:

1. Database location shape (table + id vs richer composite).
2. Mixed-source error attribution.
3. Whether to ship FR5e as part of FR-003 or as a follow-on.
