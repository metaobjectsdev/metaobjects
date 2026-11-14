# Foreign-key index conformance

The indexes `migrate.foreignKeyIndexes` gives a model's foreign keys, pinned by name and column
list, per dialect. A port that declares these indexes in its own generated model must declare
exactly these, so the mapping and the database `meta migrate` builds agree. The rule for which
foreign keys are uncovered is written once per port (TypeScript, C#, Kotlin); this corpus is
what holds the three to one answer.

## Layout

- `input/meta.fk.json`: the model.
  - `orders`: two foreign keys get an index; a third is covered by a declared `index.lookup`
    that leads with its column.
  - `order_tags`: a junction whose composite primary key covers its first foreign key.
  - `shipments`: a `@unique` field covers a foreign key; two foreign keys over one column get one
    index; a partial `index.lookup` (`@where`) covers a foreign key; a single-column foreign key
    that leads a composite one shares the composite one's index. The composite reference carries
    a `@constraintName`, because the default `<table>_<first column>_fk` name would collide with
    the single-column one.
  - `customer_order_line_item_allocations_by_region`: a foreign key whose index name is over
    63 bytes, and a declared `identity.secondary` and `index.lookup` whose names are over 63
    bytes.
- `expected.<dialect>.json`: `{ "<table>": [{ "name", "columns" }] }` for every table that gets
  a foreign-key index, in the order `meta migrate` adds them. `postgres` cuts a name over 63
  bytes to its first 63 bytes (the name Postgres stores); `sqlite` keeps the whole name.
- `declared.<dialect>.json`: the same shape for the declared indexes (`identity.secondary`,
  `index.lookup`): the name `meta migrate` creates each under, cut the same way. A generated
  model must declare these names, or a long declared name maps to an index the database does not
  hold.

## Runners

- TypeScript: `server/typescript/packages/migrate-ts/test/foreign-key-index-conformance.test.ts`
  builds the expected schema and compares each file. It is the reference:
  `META_WRITE_FK_INDEXES=1 bun test test/foreign-key-index-conformance.test.ts` (in
  `migrate-ts`) rewrites the files after a deliberate change, which is then reviewed by hand.
  `server/typescript/packages/codegen-ts/test/declared-index-name-cut.test.ts` holds the
  generated Drizzle tables to `declared.<dialect>.json`.
- C#: `server/csharp/MetaObjects.Codegen.Tests/ForeignKeyIndexConformanceTests.cs` reads
  `ForeignKeyIndexes.For`, the rule the generated EF context declares from, and
  `ForeignKeyIndexes.DeclaredIndexName` against `declared.<dialect>.json`.
- Kotlin: `server/java/codegen-kotlin/src/test/kotlin/com/metaobjects/generator/kotlin/KotlinForeignKeyIndexConformanceTest.kt`
  reads the Exposed table generator's `foreignKeyIndexes` and `declaredIndexName`.

Java and Python declare no index in a generated model (schema comes from `meta migrate`,
ADR-0015), so they do not run it. The `efcore` conventions and MySQL add no index of this kind
in any port and are not in the corpus.
