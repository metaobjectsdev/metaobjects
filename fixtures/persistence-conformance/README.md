# Persistence Conformance Corpus

End-to-end cross-language integration tests against a **real Postgres** (via
[Testcontainers]). Every supported language port runs the same scenario files
against its own MetaObjects persistence layer — generated code in C#
(`MetaObjects.Codegen` → EF Core), TS `runtime-ts`'s `ObjectManager` (Kysely), and
the equivalents for Java (OMDB) / Python as those tiers ship. **Identical
normalized results across every port is the contract.**

The corpus is **on-demand**: per-port unit test runs (`bun test`, `dotnet test`,
`pytest`, `mvn test`) stay container-free. Integration runs against this corpus
are invoked explicitly via `scripts/integration-test.sh` (or per-port runner
commands), and are required before any release publish — see
[docs/RELEASING.md](../../docs/RELEASING.md).

## Layout

```
fixtures/persistence-conformance/
├── README.md                     # this file — spec + DSL
├── normalization.md              # how each port serializes result rows
├── canonical/                    # SHARED "kitchen-sink" metadata used by every query scenario
│   └── meta.*.json
├── migrations/                   # per-scenario schema-evolution tests
│   └── <name>.yaml
└── queries/                      # query scenarios against the canonical schema
    └── <name>.yaml
```

## Two scenario kinds

### Migration scenarios (`migrations/*.yaml`)

Test the schema-evolution pipeline. Each scenario carries its own metadata
states; the runner applies the migration and asserts SQL and / or post-DDL state.

```yaml
name: add-nullable-column-to-existing-table
description: A new nullable column on an existing table → ADD COLUMN, no allow flags.

# Initial schema — what's in the DB before the migration runs.
seed-metadata: ./states/program-v1/        # path to a metadata directory
# OR an inline metadata block:
# seed-metadata-inline:
#   - { object.entity: { name: Program, children: [ ... ] } }

# Optional: raw SQL to set up before-state data (after the schema is applied).
seed-data: |
  INSERT INTO "programs" ("id", "title") VALUES (1, 'Foundations');

# Target schema — what we want the DB to look like.
target-metadata: ./states/program-v2/

# Assertions on the generated up migration (any of these may be omitted).
expect:
  blocked: []                                # no blocked changes
  up-contains:                               # substrings the up SQL must include
    - 'ALTER TABLE "programs" ADD COLUMN "subtitle" TEXT'
  up-empty: false                            # set to true to assert no-op (snapshot already matches)
  apply-up-then-query:                       # after running up.sql, run a sanity query
    sql: SELECT "id", "subtitle" FROM "programs" ORDER BY "id"
    rows:
      - { id: "1", subtitle: null }
```

### Query scenarios (`queries/*.yaml`)

Test that each port's persistence layer can read/write the canonical schema and
produce **identical normalized rows**. All query scenarios share the canonical
schema (no per-scenario metadata) so we exercise the *runtime* layer in isolation.

```yaml
name: list-programs-filtered-by-title-like
description: ObjectManager / generated DbContext must surface the same rows for a `like` filter.

# Optional seed SQL run after the canonical schema is bootstrapped.
seed-data: |
  INSERT INTO "programs" ("id", "title") VALUES
    (1, 'Foundations'), (2, 'Strength'), (3, 'Mobility');

queries:
  - name: filter-with-like
    op: list                                 # list | get | count
    entity: Program
    filter: { title: { like: "%th%" } }      # uses the standard cross-language filter ops
    sort: [{ field: id, dir: asc }]
    expect:
      - { id: "2", title: "Strength" }

  - name: get-by-id
    op: get
    entity: Program
    by: { id: 1 }                            # equivalent to filter: { id: { eq: 1 } } + first
    expect: { id: "1", title: "Foundations" }

  - name: aggregate-projection
    op: list
    entity: ProgramStat                      # read-only projection
    filter: { programId: { eq: 1 } }
    expect:
      - { programId: "1", weekCount: 3 }
```

## Query DSL (v2-day-one)

The DSL is intentionally small. Each port translates it to the most idiomatic
call into its persistence layer (C#: `_db.Set<T>().Where(...).ToListAsync()`;
TS: `om.findMany(entityName, filter, opts)`).

| field      | type                        | notes |
|------------|-----------------------------|-------|
| `op`       | `list \| get \| count`      | required |
| `entity`   | string                      | metadata name (Program, ProgramStat, …) |
| `by`       | `{ id: scalar }`            | required for `op: get` |
| `filter`   | filter object (below)       | optional; same vocabulary as Project D |
| `sort`     | `[{ field, dir }]`          | optional; `dir` ∈ `asc | desc` |
| `limit`    | integer                     | optional |
| `offset`   | integer                     | optional |
| `expect`   | row or row[] or integer     | required; the normalized expected result |

### Filter operators

Same vocabulary as the cross-language filter spec (Project D):

| op       | meaning                       |
|----------|-------------------------------|
| `eq`     | equals                        |
| `ne`     | not equals                    |
| `gt`     | greater than                  |
| `gte`    | greater than or equal         |
| `lt`     | less than                     |
| `lte`    | less than or equal            |
| `in`     | value in list                 |
| `like`   | SQL LIKE (string fields only) |
| `isNull` | true → IS NULL, false → IS NOT NULL |

Multiple field filters compose with AND.

## Result format

`expect` is the **already-normalized** value. The per-port runner reads its
result rows, applies the [normalization](./normalization.md) rules, and asserts
byte-equality (after JSON canonicalization) against `expect`. Failure prints the
exact `(scenario, query)` pair plus a row-level diff.

### Quick reference (see `normalization.md` for the full contract)

* BIGINT → JSON string (`"1"`) — JS `Number` loses precision above 2⁵³.
* INTEGER, SMALLINT → JSON number.
* BOOLEAN → JSON bool.
* NUMERIC / DECIMAL → JSON string (canonical decimal, no trailing zeros).
* TEXT / VARCHAR → JSON string.
* DATE → `"YYYY-MM-DD"`.
* TIMESTAMP (no TZ) → `"YYYY-MM-DDTHH:MM:SS[.fff]"` (no timezone suffix).
* TIMESTAMPTZ → `"YYYY-MM-DDTHH:MM:SS[.fff]Z"` (always UTC).
* UUID → lowercase canonical (`"550e8400-..."`).
* JSON / JSONB → re-serialized with **sorted keys**.
* NULL → JSON `null`.

## Per-port runner protocol

A runner walks the corpus and, for each scenario:

1. Spin up a fresh Postgres testcontainer.
2. **Migration scenarios:** apply `seed-metadata`, run `seed-data` if present,
   then run `meta migrate --from-db` against the target metadata; assert
   `expect`.
3. **Query scenarios:** apply the canonical schema, run `seed-data`, then for
   each `queries[*]` execute via the port's persistence layer, normalize, assert.
4. Tear down the container.

Failure reports `(scenario file, query name, row index, expected, actual)`.

## Adding a port

1. Drop a runner under your port (`server/<lang>/integration-tests/` or
   equivalent) that consumes this corpus.
2. Implement the DSL → persistence-layer translation.
3. Pre-generate any per-port code needed to query the canonical schema (commit
   the generated output so test runs don't depend on a working codegen pipeline
   to validate the *runtime* pipeline).
4. Wire your runner into `scripts/integration-test.sh`.
