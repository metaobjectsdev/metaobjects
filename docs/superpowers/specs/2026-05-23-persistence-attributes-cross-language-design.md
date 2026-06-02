# Persistence attributes — consolidated cross-language vocabulary (per level, per source subtype)

- **Date:** 2026-05-23
- **Status:** Design — plan-of-record for the full persistence-attribute set.
- **Companion to:** [source v2 spec](2026-05-23-source-v2-paradigm-subtypes-multisource-design.md) + [ADR-0007](../../../spec/decisions/ADR-0007-source-v2-paradigm-subtypes-multisource.md). Obeys [ADR-0006](../../../spec/decisions/ADR-0006-reserved-keywords-vs-inline-attributes.md) (reserved words bare; everything here is an `@`-attr).
- **Goal:** pull together every persistence concept already in TS (Drizzle/migrate/runtime), Java (ObjectManagerDB), and C# (EF Core) into **one normalized vocabulary**, fill the gaps (explicit referential actions, soft-delete, concurrency), and pin which attrs apply per source subtype.

> **Notation:** attribute names are shown in their **canonical JSON** spelling (`@`-prefixed: `@column`, `@onDelete`, `@storage`). In **YAML authoring** they're written sigil-free (`column:`, `onDelete:`, …); the desugar re-adds the `@` ([ADR-0006](../../../spec/decisions/ADR-0006-ai-first-yaml-authoring.md)). Reserved structural keys stay bare in both.

## 1. Archaeology — what already exists (and diverges)

| Concept | TS | Java (OMDB) | C# | normalized |
|--|--|--|--|--|
| field physical name | `@dbColumn` | `dbColumn` | `@dbColumn` | **`@column`** (per-subtype: `@field`/`@property`/…) |
| not-null | `@required` | `required`/`dbNullable` | `@required` | **`@required`** |
| max length | `@maxLength` | `dbLength` | `@maxLength` | **`@maxLength`** |
| precision/scale | `@precision`/`@scale` | `dbPrecision`/`dbScale` | `@precision`/`@scale` | **`@precision`/`@scale`** |
| unique | `@unique` | `dbUnique`/`isUnique` | `@unique` | **`@unique`** |
| index | `@db.indexed` | `dbIndex`/`isIndex` | `@db.indexed` | **`@indexed`** |
| default | `@default` | `defaultValue` | `@default` | **`@default`** |
| auto timestamp | `@autoSet: onCreate\|onUpdate` | `auto: create\|update` | `@autoSet` | **`@autoSet`** |
| PK generation | identity `@generation` | identity `generation` + `dbSequenceName` | `@generation` | **`@generation`** (+ `@sequence`) |
| db type override | (`@db.*`) | `dbType` (e.g. jsonb) | — | **`@columnType`** |
| object storage | `@storage`+`@objectRef` | `dbType=jsonb` | `@storage`+`@objectRef` (EF owned) | **`@storage`+`@objectRef`** |
| rename hint | (migrate) | `previousName` | `@previousName` | **`@previousName`** |
| relationship lifecycle | subtype assoc/aggr/comp | subtype + `jpaCascade` | subtype | subtype **+ explicit `@onDelete`/`@onUpdate`** |
| FK enforcement | (implicit) | `enforce` | (implicit) | **`@enforce`** |
| fetch strategy | — | `jpaFetch` | — | **`@fetch`** (eager/lazy) |
| table name | `@name`→`@table` | `dbTable` | `@name`→`@table` | **`@table`** (source v2) |
| composite index/unique | (per-field) | object `dbIndex`/`dbUnique` | — | **source `@indexes`/`@uniques`** |
| concurrency | — | `dbAllowDirtyWrite`/`dbDirtyWriteCheckField` | — | **`@version` field** |
| read-only | dbView subtype | `isViewOnly`/`dbView` | dbView subtype | **`@kind`-derived** (source v2) |

**Normalization rules:** drop the `db`/`jpa` prefixes and the `@db.*` namespace (legacy Java/TS) — they fragment one concept across spellings. The *paradigm* is already carried by the source subtype, so attrs are bare and paradigm-neutral where the concept generalizes, and per-subtype only where the concept genuinely differs (physical name).

## 2. Field-level attributes (`field.*`)

| attr | values | applies to | meaning |
|--|--|--|--|
| `@column` / `@field` / `@property` / … | string | all | physical address in the record (per source subtype; §source-v2) |
| `@required` | bool | all | NOT NULL / required |
| `@maxLength` | int | string | varchar(N) / max length |
| `@precision` / `@scale` | int | decimal | numeric(p,s) |
| `@default` | literal \| sqlExpr (`now`, `CURRENT_TIMESTAMP`, `uuid()`) | all | column default |
| `@unique` | bool | all | single-column unique |
| `@indexed` | bool \| index-name | all | create an index |
| `@autoSet` | `onCreate` \| `onUpdate` | date/timestamp | auto-managed timestamp (createdAt/updatedAt) |
| `@columnType` | string | all | escape hatch: explicit physical type (e.g. `jsonb`, `citext`) |
| `@storage` | `flattened` \| `jsonb` \| `subdocument` | object (`@objectRef`) | nested-object storage strategy (see §6) |
| `@objectRef` | object name | object | the nested/referenced object |
| `@filterable` / `@sortable` | bool | all | query-layer (Project D) |
| `@previousName` | string | all | migration rename hint |

## 3. Identity-level attributes (`identity.*`)

| attr | values | meaning |
|--|--|--|
| `@fields` | string[] | the field(s) forming the identity |
| `@generation` | `increment` \| `uuid` \| `assigned` \| `sequence` \| `identity` | PK generation strategy |
| `@sequence` | string | sequence name (when `@generation: sequence`) |
| `@unique` | bool | secondary identity ⇒ unique constraint |

Subtypes: `primary` (one; the PK), `secondary` (business/alt keys), **`reference`** (FK fields → another entity; from Java) with `@references` (target `Entity`/`Entity.id`) + `@enforce` (physical FK on/off).

## 4. Relationship-level attributes (`relationship.*`) — incl. the new referential actions

Subtypes carry **default** lifecycle; explicit attrs **override**:

| attr | values | default (from subtype) | meaning |
|--|--|--|--|
| `@objectRef` | object name | — | target entity |
| `@cardinality` | `one` \| `many` | — | relationship cardinality |
| **`@onDelete`** | `cascade` \| `set-null` \| `restrict` \| `no-action` | composition→`cascade`, aggregation→`set-null`, association→`restrict` | **referential action on parent delete (NEW)** |
| **`@onUpdate`** | (same `FkAction` set) | `cascade` | **referential action on key update (NEW)** |
| `@enforce` | bool | `true` | physical FK constraint vs logical-only |
| `@fetch` | `eager` \| `lazy` | `lazy` | load strategy (codegen/runtime hint) |
| `@through` | object name | — | M:N junction/through entity (FR-017; declares two `identity.reference` children — FK fields are derived, not restated). Replaces the removed `@joinEntity`/`@joinFields`. |
| `@sourceRefField` | string | — | M:N directed self-join: names the source-side FK field on the junction (FR-017) |
| `@symmetric` | bool | `false` | M:N undirected self-join, union-on-read; self-join-only + mutually exclusive with `@sourceRefField` (FR-017) |

**The value set is the existing `FkAction` union — `cascade | set-null | restrict | no-action`** ([migrate-ts `types.ts:65`](../../../server/typescript/packages/migrate-ts/src/types.ts)), kebab-case, **no `setDefault`** (the emitters don't carry it; MySQL doesn't support it). The authoring value === the `FkDescriptor` value, so it threads straight through with no translation layer.

**`@onDelete` and `@autoSet` are different axes on different metatypes — do NOT unify them.** `@autoSet: onCreate|onUpdate` is a one-off *field* write-fill on a timestamp column; `@onDelete`/`@onUpdate` are *relationship* referential actions. There is no general "behavior on write" infrastructure and we are not inventing one — folding these into a single lifecycle hook would be over-engineering.

**Defaults-from-subtype** keep the common case zero-config (a `composition` cascades; an `association` restricts) while `@onDelete`/`@onUpdate` expose and override that intent. Note this is a *small new inference* — today the metadata→schema side leaves the action unset (FKs emit no action clause); we add the derive-from-subtype default + the explicit override. Caveat: `set-null` requires an optional (nullable) relation; `verify`/migrate flags violations.

## 5. Source/object-level attributes

| attr | level | meaning |
|--|--|--|
| `@table`/`@collection`/… | source | physical object name (source v2) |
| `@schema` | source.rdb | DB schema/namespace |
| `@kind` | source | object kind; drives read-only (source v2) |
| `@role` | source | multi-source role (source v2) |
| `@indexes` | source/object | composite indexes (multi-column) |
| `@uniques` | source/object | composite unique constraints |
| `@version` | field/object | optimistic-lock version column (replaces Java dirty-write) |
| `@softDelete` | object | soft-delete mode: a `deletedAt` timestamp (or `deleted` flag) + read-filter; distinct from DB `@onDelete` |

## 6. Object storage (`@storage`) — answer to "the C# jsonb thing"

On a `field.object` (with `@objectRef`):

| `@storage` | relational (rdb) | document | meaning |
|--|--|--|--|
| `flattened` | nested columns expand into the parent table, prefixed (EF Core `OwnsOne`); `isArray` forbidden | n/a | owned/embedded, one set of columns |
| `jsonb` | a single `jsonb` column holds the structured value (or array when `isArray`) | native nested | typed-by-metadata, opaque storage |
| `subdocument` | (no relational column emitted) | native nested document | document-store-native |

Absent ⇒ default single-jsonb-column (back-compat). Validation: `flattened` + `isArray` ⇒ `ERR_STORAGE_FLATTENED_ARRAY`; `@storage` without `@objectRef` ⇒ `ERR_STORAGE_WITHOUT_OBJECT_REF` (both exist).

## 7. Per-source-subtype applicability

Most attrs are **rdb**-centric. Applicability deltas:

| attr group | rdb | document | event | keyValue | graph | search | vector | timeSeries |
|--|--|--|--|--|--|--|--|--|
| `@required`/`@default`/`@unique` | ✓ | ✓ | (schema) | ✓ | ✓ | ✓ | ✓ | ✓ |
| `@maxLength`/`@precision`/`@scale` | ✓ | — | — | — | — | — | — | — |
| `@indexed`/`@indexes`/`@uniques` | ✓ | ✓ | — | `@gsi` | ✓ | (mapping) | — | ✓ |
| `@autoSet` | ✓ | ✓ | (event time) | ✓ | ✓ | ✓ | — | `@timeColumn` |
| `@generation` | ✓ | ✓ (`_id`) | — | `@partitionKey` | ✓ | ✓ | ✓ | — |
| `@onDelete`/`@onUpdate`/`@enforce` | ✓ | (app-level) | — | — | ✓ (edges) | — | — | — |
| `@storage` | ✓ (jsonb/flattened) | subdocument | — | — | — | — | — | — |
| `@version`/`@softDelete` | ✓ | ✓ | — | ✓ | ✓ | — | — | — |
| paradigm-specific | `@schema` | `@database` | `@keySchema`/`@valueSchema`/`@partitions` | `@partitionKey`/`@sortKey`/`@ttl` | `@from`/`@to` | `@mappingsRef` | `@dimensions`/`@metric` | `@retention`/`@tags` |

## 8. What's new vs. today (the gaps we're filling)

1. **Explicit `@onDelete`/`@onUpdate` referential actions** — **low effort, high value: the plumbing already exists end-to-end and only the authoring attribute is missing.** The `FkAction` union (`cascade|set-null|restrict|no-action`), `FkDescriptor.onDelete/onUpdate`, the DDL **emit** (`migrate-ts/src/emit/{postgres,sqlite}.ts`), **introspect**, and **diff** are all built (TS confirmed; C# `PostgresEmit.cs` per the same design). What's absent is the `@onDelete`/`@onUpdate` attr on the relationship schema and threading its value into the expected-schema `FkDescriptor` (today that field is left unset → FKs emit no action clause). So the task is: add the two attrs (`allowedValues = FkAction`), thread them in, add a conformance fixture. Exposing intent, not building plumbing.
2. **`@enforce`** (physical vs logical FK) and **`@fetch`** promoted from Java-only to the cross-language vocabulary.
3. **`@softDelete`** and **`@version`** as first-class declarations (today: ad-hoc / Java-only dirty-write).
4. **`@generation: sequence`/`identity`** + `@sequence` (Java had `dbSequenceName`; generalize).
5. **Normalized names** — Java `db*`/`jpa*` and TS `@db.*` collapse into the bare cross-language set above.

## 9. Open questions

- `@onDelete` default for **aggregation** — `set-null` vs `restrict`? (Prisma defaults required→restrict; our aggregation = shared ownership ⇒ `set-null` feels right but needs the relation optional.) Resolve in review.
- `@softDelete` granularity — object-level mode only, or per-relationship cascade-of-soft-delete? (Start object-level; defer cascade-soft-delete.)
- `@version` representation — a dedicated `@version` field marker vs an object-level `@optimisticLock: <field>`. (Lean: a field-level `@version: true`.)
- Which attrs are **conformance-gated** (loader/serializer round-trip) vs **codegen-only** (golden tests). Referential actions + storage round-trip in metadata; physical-type escape hatches are codegen-only.

## 10. Research

- Prisma referential actions: `Cascade`/`Restrict`/`NoAction`/`SetNull`/`SetDefault`; defaults ON DELETE RESTRICT (required) / ON UPDATE CASCADE; `SetNull` needs optional relation; `SetDefault` unsupported on MySQL. ([Prisma referential actions](https://www.prisma.io/docs/orm/prisma-schema/data-model/relations/referential-actions)) — **we adopt the existing 4-value `FkAction` (`cascade|set-null|restrict|no-action`), omitting `setDefault`** to match what the emitters already carry.
- Soft delete is an application/middleware pattern (`deletedAt`/`deleted` + read-filter), not a DB referential action. ([Prisma soft-delete](https://www.prisma.io/docs/orm/prisma-client/client-extensions/middleware/soft-delete-middleware))
- JPA cascade types (ALL/PERSIST/MERGE/REMOVE/…) + fetch (EAGER/LAZY) informed `@onDelete`/`@fetch` (Java `jpaCascade`/`jpaFetch`).
