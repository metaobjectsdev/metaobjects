# Source v2 — paradigm subtypes, logical names, multi-source, per-subtype physical addresses

- **Date:** 2026-05-23
- **Status:** Design — plan-of-record. Authority for the `source` metatype going forward.
- **Decision record:** [ADR-0007](../../../spec/decisions/ADR-0007-source-v2-paradigm-subtypes-multisource.md) (the durable contract); this spec is the detailed design + migration + rollout.
- **Supersedes:** FR-003 / Project E `source.dbTable` / `source.dbView`.
- **Related:** [ADR-0006](../../../spec/decisions/ADR-0006-reserved-keywords-vs-inline-attributes.md) (reserved keywords vs `@`-attrs — resolved here for `source`), ADR-0002 (subtype behavior), ADR-0004 (per-subtype attr schemas).
- **Companion:** [persistence attributes spec](2026-05-23-persistence-attributes-cross-language-design.md) — the full per-level, per-subtype attribute vocabulary (field/identity/relationship/source), including the new explicit `@onDelete`/`@onUpdate` referential actions, `@storage`, `@softDelete`, `@version`.

> **Notation (per revised [ADR-0006](../../../spec/decisions/ADR-0006-reserved-keywords-vs-inline-attributes.md)):** metadata keys are **bare — no `@` sigil**. Where this doc writes `@table`, `@kind`, `@role`, `@onDelete`, etc., read them as the bare keys `table`, `kind`, `role`, `onDelete`; the `@` is dropped metamodel-wide. The tables retain the `@`-form only until this doc is normalized in implementation.

## 1. Model (the rules)

A `source` declares **where an object's data physically lives**. Rules:

1. **Subtype = storage paradigm** (`rdb`, `document`, `event`, …). The paradigm selects the
   codegen/runtime driver, so it's the behavioral axis (ADR-0002). Each subtype owns its
   attribute vocabulary (ADR-0004).
2. **`name` = logical name** (optional on sources), consistent with every node (ADR-0006).
3. **Physical address = a per-subtype idiomatic attribute** at both the source and field level
   (`@table`+`@column`, `@collection`+`@field`, …). Never `@name`. Omitted ⇒ derived from `name`
   via the naming strategy.
4. **`@kind`** = object kind within the paradigm (default per paradigm); read-only-ness derived
   from it.
5. **`@role`** = multi-source role (default `primary`). An object may have N sources; exactly one
   `primary`.

## 2. Paradigm catalog (subtypes)

| `source.<subtype>` | example backends | source physical attr | `@kind` (default*→variants) | paradigm-specific attrs |
|--|--|--|--|--|
| **rdb** | Postgres, MySQL, SQLite, SQL Server, Oracle | `@table` | table* · view · materializedView · storedProc · tableFunction | `@schema`, `@refresh`(matview), `@params`(proc/fn) |
| **document** | MongoDB, CouchDB, Cosmos, Firestore | `@collection` | collection* · view · gridFs | `@database`, `@viewOn`+`@pipeline`(view) |
| **event** | Kafka, Pulsar, Kinesis | `@topic` | topic* · stream · eventStore · changelog | `@keySchema`, `@valueSchema`, `@partitions`, `@compaction`, `@consumerGroup` |
| **keyValue** | DynamoDB, Redis, etcd | `@table` / `@namespace` | table* · keyspace | `@partitionKey`, `@sortKey`, `@gsi`, `@ttl` |
| **wideColumn** | Cassandra, ScyllaDB, Bigtable | `@table` | table* | `@keyspace`, `@partitionKey`, `@clusteringKey`, `@columnFamily` |
| **graph** | Neo4j, Neptune, ArangoDB | `@label` / `@edge` | node* · relationship | `@from`, `@to` (relationship) |
| **search** | Elasticsearch, OpenSearch, Solr | `@index` | index* · alias | `@mappingsRef`, `@targets`(alias) |
| **vector** | Qdrant, Pinecone, Weaviate, pgvector | `@collection` | collection* | `@dimensions`, `@metric` |
| **timeSeries** | TimescaleDB, InfluxDB, Prometheus | `@measurement` | hypertable* · measurement | `@timeColumn`, `@retention`, `@tags` |
| **objectStore** | S3, GCS, Azure Blob (+ parquet/csv) | `@path` | object* | `@format`, `@partitionBy` |
| **api** | REST, GraphQL, gRPC | `@endpoint` | rest* · graphql · grpc | `@method`, `@operation`, `@service` |
| **memory** | in-memory / fixtures / tests | `@key` | map* | — |

## 3. The 20-variety stress test (proves the shape generalizes)

(`*` = default kind; R/W column derived from `@kind`.)

| # | subtype.kind | `name`/physical | extra attrs | R/W |
|--|--|--|--|--|
| 1 | rdb.table* | `@table` | `@schema` | RW |
| 2 | rdb.view | `@table` | `@schema` | RO |
| 3 | rdb.materializedView | `@table` | `@schema`, `@refresh` | RO |
| 4 | rdb.storedProc | `@table` | `@schema`, `@params` | RO |
| 5 | rdb.tableFunction | `@table` | `@schema`, `@params` | RO |
| 6 | document.collection* | `@collection` | `@database` | RW |
| 7 | document.view | `@collection` | `@viewOn`, `@pipeline` | RO |
| 8 | document.gridFs | `@collection` | `@chunkSize` | RW |
| 9 | keyValue.table* (DynamoDB) | `@table` | `@partitionKey`, `@sortKey`, `@gsi`, `@ttl` | RW |
| 10 | keyValue.keyspace (Redis) | `@namespace` | `@ttl` | RW |
| 11 | wideColumn.table* | `@table` | `@keyspace`, `@partitionKey`, `@clusteringKey` | RW |
| 12 | graph.node* | `@label` | — | RW |
| 13 | graph.relationship | `@edge` | `@from`, `@to` | RW |
| 14 | search.index* | `@index` | `@mappingsRef` | RW |
| 15 | search.alias | `@index` | `@targets` | RO |
| 16 | vector.collection* | `@collection` | `@dimensions`, `@metric` | RW |
| 17 | timeSeries.hypertable* | `@measurement` | `@timeColumn`, `@retention`, `@tags` | append |
| 18 | objectStore.object* | `@path` | `@format`, `@partitionBy` | RO-mostly |
| 19 | api.rest* | `@endpoint` | `@method`, `@path` | per-verb |
| 20 | memory.map* | `@key` | — | RW |

The structure holds across all 20: a named object (`name` logical + a paradigm physical attr),
plus a per-paradigm optional-attr set that ADR-0004 already homes on the subtype.

## 4. Field-level physical names

The same per-subtype principle, one level down — a field's address *within* a record:

| paradigm | field physical attr | notes |
|--|--|--|
| rdb / wideColumn / objectStore | `@column` | renames the old `@dbColumn` |
| document / event / search / vector | `@field` | dotted path allowed (`name.first`) |
| graph | `@property` | |
| keyValue | `@attribute` | |
| timeSeries | `@column` / `@tag` | Influx tag vs field distinction |
| api | `@jsonPath` | |

**Multi-source fields carry one per paradigm — no collision, because the names differ:**
```jsonc
{ "field.string": { "name": "firstName",
                    "@column": "first_name",   // consumed by the rdb source's codegen
                    "@field":  "name.first" } } // consumed by the document source's codegen
```
Omitting the physical attr ⇒ derived from `name` via the naming strategy.

## 5. Multi-source + `@role`

An object may declare multiple `source` children:

```jsonc
{ "object.entity": { "name": "Product", "children": [
  { "source.rdb":      { "@table": "products", "@schema": "catalog" } },     // primary (default), table
  { "source.search":   { "@index": "products_idx", "@role": "index" } },     // maintained on write
  { "source.event":    { "@topic": "product.changed", "@role": "publish" } },// CDC / outbox
  { "source.keyValue": { "@namespace": "product:", "@role": "cache", "@ttl": 300 } }
  /* …fields… */
]}}
```

| `@role` | meaning | drives |
|--|--|--|
| `primary`* | system of record (may be read-only for a projection) | CRUD / canonical read |
| `replica` | read copy (read replica, matview) | read routing |
| `index` | search/vector index derived from primary | search queries; maintained on write |
| `cache` | read-/write-through cache | cache get/set |
| `publish` | event/stream sink (CDC, outbox, event-sourcing) | emit-on-write |
| `mirror` | dual-write (migration) | parallel write |

**Validation:** exactly one `primary` per object (`ERR_SOURCE_NO_PRIMARY` / `ERR_SOURCE_MULTIPLE_PRIMARY`). Single-source objects need no `@role` (defaults to `primary`).

## 6. `@kind` + read-only derivation

`@kind` defaults per paradigm (rdb→`table`, document→`collection`, graph→`node`, …). Read-only
kinds (rdb `view`/`materializedView`/`storedProc`/`tableFunction`, document `view`, search
`alias`) make the source read-only — codegen emits read-only model/queries/routes for a source
whose effective `@kind` is read-only, replacing FR-003's "the subtype is `dbView`" check.

## 7. Migration from FR-003

| FR-003 | Source v2 |
|--|--|
| `source.dbTable` | `source.rdb` (kind defaults to `table`) |
| `source.dbView` | `source.rdb` + `@kind: view` |
| `@name: "products"` | `@table: "products"` |
| `@schema` | `@schema` (unchanged) |
| field `@dbColumn` | field `@column` |
| (implicit single source) | one `source`, `@role` defaults to `primary` |

Read-only codegen dispatch: `subType === dbView` → `effectiveKind ∈ READ_ONLY_KINDS`.

## 8. Conformance corpus changes

- Migrate every `source.*` fixture (`source-db-table-*`, `source-db-view-*`,
  `field-object-storage-*`, `origin-*`, projection fixtures) to `source.rdb` + `@kind` + `@table`
  + `@column`. Regenerate `expected.json`.
- This **resolves the ADR-0006 `source.@name` violation** (physical name → non-reserved `@table`).
- Keep the ADR-0006 changes already staged: `error-reserved-word-as-attr` (→ `ERR_RESERVED_ATTR`)
  and `origin-collection-simple`'s field `@isArray` → bare `isArray`.
- New `@role` fixtures: a multi-source object (one primary + secondaries) and the
  no-primary / multiple-primary error fixtures.

## 9. Cross-language rollout (sequencing)

Each language: (a) loader — replace `dbTable`/`dbView` subtypes with `rdb` + `@kind`, add the
paradigm physical attrs + `@kind`/`@role` schemas, rename `@dbColumn`→`@column`, add
multi-source validation; (b) consumers — read-only off `@kind`, source name off `@table`, field
name off `@column`, route by `@role`; (c) conformance green on the migrated corpus.

Order: **shared corpus + ADR-0006 enforcement first**, then **TS** (reference) → **C#** → **Java**
→ **Python**. Only `source.rdb` is implemented; the other ten paradigms register on demand. Folds
in the ADR-0006 reserved-word enforcement (which becomes viable once `source.@name` is gone).

## 10. Out of scope

- The ten non-rdb paradigms as *implementations* (validated design; built per backend on demand).
- **Per-source-instance** field locators (a field differing across two sources of the *same*
  paradigm) — per-*paradigm* is covered; per-instance is a future refinement.
- The assembler (multi-source read/write orchestration at runtime) — a runtime concern, host-side.
- Provider/connection configuration (stays runtime config, as the dialect is today).
