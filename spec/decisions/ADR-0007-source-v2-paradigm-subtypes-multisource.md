# ADR-0007 — Source metatype v2: storage-paradigm subtypes, logical names, multi-source, per-subtype physical addresses

**Status:** Accepted (proposed 2026-05-23; shipped in all five ports). **Amended 2026-08-05**
([#212](https://github.com/metaobjectsdev/metaobjects/issues/212)) — see Amendments 1 and 2:
`event` is removed from the paradigm catalog and replaced by an explicit admission test
("addressable state at rest"), and `@role`'s registered vocabulary shrinks to `primary | replica`.

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

1. **Subtype = storage paradigm**, not object kind: `source.{rdb, document, keyValue,
   wideColumn, graph, search, vector, timeSeries, objectStore, api, memory}`. The paradigm is the
   real behavioral axis (it selects the codegen/runtime driver — JOOQ/SQLAlchemy vs a document
   ODM vs a search client), so it belongs on the subtype per ADR-0002. Each paradigm owns its
   attribute vocabulary per ADR-0004.

   **Amended 2026-08-05 (#212): `event` is removed from the catalog** — see
   *Amendment 1* below for the admission test that governs which paradigms belong here at all.

2. **`name` = logical name (optional); physical address = a per-subtype idiomatic attribute**,
   at **both** the source and field level (ADR-0006-compliant; the physical name is never `@name`):

   | level | rdb | document | graph | search | … |
   |---|---|---|---|---|---|
   | source physical | `@table` | `@collection` | `@label`/`@edge` | `@index` | per paradigm |
   | field physical | `@column` | `@field` | `@property` | `@field` | per paradigm |

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
   `@role` (default `primary`). **Exactly one `primary`** per object; the primary is the system of
   record and drives CRUD/canonical reads. Single-source objects are unchanged: one source, role
   defaults to `primary`.

   **Amended 2026-08-05 (#212 sub-decision): the registered vocabulary is `primary | replica`** —
   see *Amendment 2* below.

## Amendment 1 (2026-08-05, #212) — the admission test: addressable state at rest

ADR-0028 subsequently ruled that "message topics/queues are *channels*, not sources — they live at
the surface layer as `binding.*` on operations, never in `source.*`", which contradicted this ADR's
`source.event @topic @role: publish` catalog entry. Both were on the books. Resolved in favour of
ADR-0028, and generalized into the test that governs the whole catalog:

> A `source.*` binds an object to **addressable state at rest** — a place where a current value of
> an instance can be read on demand by a declared key or address, not merely observed as it flows
> past. **Drift-inspectability is NOT an admission criterion.** It follows per paradigm from
> whatever schema authority the backend exposes (`information_schema`, index mapping, schema
> registry, parquet footer) and may be absent entirely; it is a `verify` capability.

The second sentence is load-bearing. A two-prong test requiring both addressability *and* a
drift-inspectable schema fails in both directions: it would **admit** a schema-registry-backed Kafka
topic (Confluent exposes key/value schemas) and **exclude** `source.memory` (nothing exists to drift
against), while wrongly maiming `document` (`$jsonSchema` optional), `keyValue` (Redis has none),
`objectStore` (parquet yes, CSV no), `timeSeries` (Timescale yes, Prometheus no) and `graph`.

Under the single-prong test only **`event`'s flow kinds (topic / stream)** fall. "Get-by-id"
generalizes to "get-by-declared-key/address", so composite keys (`keyValue`), paths
(`objectStore`) and series+time (`timeSeries`) all qualify; `vector` and `search` qualify too, since
both expose fetch-by-id (similarity is the *query* path, not the only read).

**Escape clause — principled, not ad hoc:** *a stream becomes a source exactly when it is treated as
addressable state.* A compacted changelog or event store read by key (KTable-style) enters as an
ordinary read-only-`@kind` paradigm source. What stays out is only the **flow** itself; modeling a
flow as storage is the category error. Windowed/stateful stream aggregation stays out
**permanently** — it violates the determinism contract that a derivation is a pure function of the
*current* entity graph, and is stream *processing*, not projection.

**Where emission goes instead:** the surface layer (`api.eventing` / `operation.event` /
`binding.messaging`, per ADR-0030), with the event's payload referencing an `object.projection`.
This lands the symmetry — **queries return projections, commands take values, events emit
projections** — and the projection concept still does all the shape work; only the exposure is a
channel binding rather than a source.

## Amendment 2 (2026-08-05, #212 sub-decision) — `@role` is a designation, not a routing mechanism

The Consequences below say codegen and runtime "route by `@role` (primary = CRUD; index/cache/publish
= derived)". **No port ever built that dispatch.** Across all five, every read of `@role` is an
equality test against `primary`: Java's OMDB has zero role usage, and Kotlin's `KotlinGenUtil` and
Python's write-through read path are explicitly documented *role-agnostic* — they find the replica
view by read-only `@kind`. The consumed information content is one bit.

Accordingly:

- **Registered vocabulary shrinks to `primary | replica`.** `index`, `cache`, `publish` and `mirror`
  are **reserved — documented here, NOT registered**, the same treatment ADR-0040 gave
  `index.fulltext` / `index.vector` / `index.spatial`. (`publish` is additionally dead on doctrine:
  emission is a surface concern per Amendment 1.)
- **Re-entry bar:** *a role member enters the registry only when a shipping consumer dispatches on
  it.* Registration did not summon the routing feature over the project's life; reserving costs a
  future adopter one paragraph, and re-entry post-1.0 is additive whereas removal would be a 2.0
  event.
- **`replica` is structurally required**, despite no consumer reading the word: `@role` defaults to
  `primary` when omitted and the one-primary invariant rejects two primaries, so a *second* source
  must carry an explicit non-primary role or the model fails to load. The enum cannot shrink below
  two members without redesigning the default.
- **`@role` is not derivable** (so it survives ADR-0037 as a step-3 configuration attribute):
  primacy is a tie-breaking *designation*, and `table(primary)` + `table(replica)` — two
  same-writability sources — is legal and becomes inexpressible under any "the writable one is
  primary" derivation.

For consumer-meaningless author annotations about a source's purpose, the chartered home is the
registered `attr.properties` bag (ADR-0023), not members of a byte-checked enum whose presence
implies behavior that does not exist.

## Consequences

- **Cross-language migration** (TS / C# / Java / Python): the loader subtype set changes
  (`dbTable`/`dbView` → `rdb` + `@kind`), `@name` → `@table`, `@dbColumn` → `@column`, and
  `@role` + multi-source validation (exactly one primary) are added.
- **Codegen/runtime** stop dispatching read-only off the *subtype* and instead off **`@kind`**,
  and stop assuming one source — they select the primary by `@role` and everything else by
  `@kind`. Degrades gracefully: no secondaries ⇒ today's behavior. *(As shipped, `@role` selects
  only the primary; the "route by `@role`" routing this originally anticipated was never built —
  see Amendment 2.)*
- **Conformance corpus** migrates every `source.*` fixture; this also resolves the ADR-0006
  `source.@name` violation (the physical name moves to the non-reserved `@table`).
- **Scope is staged.** Only `source.rdb` is implemented now (it covers everything FR-003 does);
  the other paradigms are a validated roadmap, each built when a backend lands — subject to the
  Amendment 1 admission test.
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
