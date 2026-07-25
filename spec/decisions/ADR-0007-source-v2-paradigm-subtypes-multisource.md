# ADR-0007 — Source metatype v2: storage-paradigm subtypes, logical names, multi-source, per-subtype physical addresses

**Status:** Accepted (proposed 2026-05-23; shipped in all five ports)

**Supersedes:** the `source.dbTable` / `source.dbView` vocabulary introduced for FR-003
(Project E, "Source-aware entities + projections"). Builds on ADR-0002 (subtype behavior on
the node), ADR-0004 (provider-based per-subtype attr schemas), and ADR-0006 (reserved keywords
vs `@`-inline-attributes).

## Context

FR-003 modeled an object's storage binding as `source.dbTable` (writable) / `source.dbView`
(read-only), with `@name` carrying the physical object name and `@schema` the DB schema. In use
this surfaced four problems:

1. **Relational-centric & non-extensible.** The subtype encodes a *relational object kind*.
   Document/streaming/graph/search/vector/object-store backends would each need new subtypes,
   and read-only-ness (view) is fused into the subtype — so the axis doesn't generalize.
2. **`@name` violates ADR-0006.** `name` is a reserved structural keyword (the logical name);
   `source.dbTable @name: "products"` uses the attribute sigil on a reserved word. Enforcing
   ADR-0006 breaks every source fixture.
3. **No multi-source.** An object can only bind one source, but real systems are polyglot — a
   table that is *also* search-indexed, cached, and published to an event log (CQRS / outbox /
   read replicas). There is no way to declare that.
4. **Inconsistent physical naming.** The physical name was `@name` at the source level but
   `@dbColumn` at the field level — two conventions for the same concept.

Prior art (researched): ORMs separate the **provider/backend** (a connection concern — Prisma's
`datasource.provider`, JPA's dialect) from **object mapping** (Prisma `@@map`, JPA
`@Table(name)`); read-only-ness is a *modifier* (`@Immutable`), not a type; "logical vs physical
name" is standard data-modeling; data catalogs address assets per-paradigm. MetaObjects already
treats the dialect/provider as runtime config and metadata as backend-agnostic.

## Decision

**Source v2** restructures the `source` metatype along four rules:

1. **Subtype = storage paradigm**, not object kind: `source.{rdb, document, event, keyValue,
   wideColumn, graph, search, vector, timeSeries, objectStore, api, memory}`. The paradigm is the
   real behavioral axis (it selects the codegen/runtime driver — JOOQ/SQLAlchemy vs a document
   ODM vs a Kafka client), so it belongs on the subtype per ADR-0002. Each paradigm owns its
   attribute vocabulary per ADR-0004.

2. **`name` = logical name (optional); physical address = a per-subtype idiomatic attribute**,
   at **both** the source and field level (ADR-0006-compliant; the physical name is never `@name`):

   | level | rdb | document | event | graph | … |
   |---|---|---|---|---|---|
   | source physical | `@table` | `@collection` | `@topic` | `@label`/`@edge` | per paradigm |
   | field physical | `@column` | `@field` | `@field` | `@property` | per paradigm |

   `@dbColumn` is renamed **`@column`**. When a physical attr is omitted it is derived from the
   logical `name` via the naming strategy (today's column-naming behavior, generalized). Because
   the attr *names* differ per paradigm, a multi-sourced field can carry several with no
   collision (`@column` for the rdb source, `@field` for the document source).

3. **`@kind` = object kind within a paradigm**, with a per-paradigm default; read-only-ness is
   derived from it. rdb: `table`* / `view` / `materializedView` / `storedProc` / `tableFunction`
   (view/matview/proc/fn ⇒ read-only). graph: `node`* / `relationship`. document: `collection`* /
   `view`. The paradigm word the reader expects lives in `@kind`, so the physical-name attr stays
   the dominant noun.

4. **Multi-source via `@role`.** An object may declare **N `source` children**; each carries
   `@role` (default `primary`): `primary` (system of record; may be read-only for a projection),
   `replica`, `index`, `cache`, `publish`, `mirror`. **Exactly one `primary`** per object. The
   primary drives CRUD/canonical reads; secondaries drive derived behavior (index maintenance,
   cache, event emission). Single-source objects are unchanged: one source, role defaults to
   `primary`.

## Consequences

- **Cross-language migration** (TS / C# / Java / Python): the loader subtype set changes
  (`dbTable`/`dbView` → `rdb` + `@kind`), `@name` → `@table`, `@dbColumn` → `@column`, and
  `@role` + multi-source validation (exactly one primary) are added.
- **Codegen/runtime** stop dispatching read-only off the *subtype* and instead off **`@kind`**,
  and stop assuming one source — they **route by `@role`** (primary = CRUD; index/cache/publish =
  derived). Degrades gracefully: no secondaries ⇒ today's behavior.
- **Conformance corpus** migrates every `source.*` fixture; this also resolves the ADR-0006
  `source.@name` violation (the physical name moves to the non-reserved `@table`).
- **Scope is staged.** Only `source.rdb` is implemented now (it covers everything FR-003 does);
  the other ten paradigms are a validated roadmap, each built when a backend lands.
- **Back-compat:** `dbTable`/`dbView` documents stop loading. Intended — they are migrated in the
  shared corpus, and `source` is pre-1.0.

## Alternatives considered

- **Keep `dbTable`/`dbView`, only fix `@name`.** Smallest, but leaves the metatype
  relational-centric and gives no multi-source path. Rejected — kicks the can.
- **Generic physical-address attr (`@locator`/`@map`) at both levels.** One uniform word; great
  for tooling lookups. Rejected — non-idiomatic across paradigms, and a *single* attr can't hold
  a multi-sourced field's per-paradigm addresses (`@column` *and* `@field`), which per-subtype
  attrs do for free.
- **Paradigm as an attribute, object-kind as the subtype.** Inverts which distinction is the
  type; read/write (the real behavioral driver) would become an attr. Rejected per ADR-0002.

## Realization status

- **Spec:** detailed design + paradigm catalog + migration in
  `docs/superpowers/specs/2026-05-23-source-v2-paradigm-subtypes-multisource-design.md`.
- **TypeScript / C# / Java / Python:** _pending_ (rdb slice first).
