# ADR-0018 — Per-kind physical-name attributes within source paradigms

**Status:** Accepted (proposed 2026-05-28; shipped in all five ports)
**Applies to:** all five language ports (TypeScript reference + Java / Kotlin / C# / Python); the `source` metatype attribute vocabulary.
**Refines:** [ADR-0007](ADR-0007-source-v2-paradigm-subtypes-multisource.md) (source-v2 paradigm). Re-opens the within-paradigm physical-name attribute decision without abandoning the per-paradigm idiom principle.
**Related:** [ADR-0002](ADR-0002-open-closed-typed-nodes.md) (open-closed typed nodes), [ADR-0013](ADR-0013-logical-field-types-vs-physical-column-attributes.md) (logical/physical layer split).

## Context

ADR-0007 introduced the source-v2 paradigm and established the rule that the physical-address attribute is *per-paradigm-idiomatic*: `@table` for `source.rdb`, `@collection` for `source.document`, `@index` for `source.search`, `@label`/`@edge` for `source.graph`. The Alternatives Considered section rejected a single generic `@locator` / `@map` attribute on the grounds that paradigms have genuinely different vocabularies and a multi-sourced field needs paradigm-specific addresses (`@column` for the rdb side, `@field` for the document side, simultaneously).

That per-paradigm principle is correct and is preserved here.

Where ADR-0007 made a separate, weaker choice was inside the `rdb` paradigm: it picked `@table` as the universal physical-name attr across every `@kind` value (`table` / `view` / `materializedView` / `storedProc` / `tableFunction`). The reasoning given — "the paradigm word the reader expects lives in `@kind`, so the physical-name attr stays the dominant noun" — does not survive comparison with industry practice. Stored procedures are not tables; views are not tables; SQL itself uses distinct DDL keywords; every major ORM uses distinct annotations or APIs:

| Stack | Table | View | Stored Proc / Function |
|---|---|---|---|
| EF Core | `[Table("X")]` | `ToView("X")` | `HasFunction(...)` |
| Hibernate / JPA | `@Table(name="X")` | `@Subselect(...)` | `@NamedStoredProcedureQuery` |
| SQLAlchemy | `__tablename__` | view-helpers | `func.X(...)` |
| Django | `Meta.db_table` | `Meta.managed=False` | raw `cursor.callproc` |
| Prisma | `@@map` on `model` | `@@map` on `view` (separate keyword) | (raw SQL only) |
| Drizzle | `pgTable("X", ...)` | `pgView("X", ...)` | (raw SQL only) |
| TypeORM | `@Entity({ name })` | `@ViewEntity({ name })` | (raw SQL only) |
| SQL standard | `CREATE TABLE` | `CREATE VIEW` | `CREATE PROCEDURE` / `CREATE FUNCTION` |

Zero of them call a non-table relation "table." The single-attr choice in ADR-0007 was a deviation from universal practice, made for internal-design simplicity at the cost of reader ergonomics. Metadata files in adopter projects would read `@table: "fn_get_phase_summary_per_case"` with `@kind: "storedProc"` — internally consistent but immediately disorienting to anyone scanning the source.

The decision to revisit happens now because:
1. **No external adopters depend on `@table`-for-everything yet.** The cost of revising is bounded; the cost of shipping the smell to 1.0 is permanent.
2. **The argument from ADR-0007 against generic uniformity doesn't extend.** ADR-0007's rejection of `@locator` addressed *cross-paradigm* uniformity. Within a paradigm, per-kind aliases all writing to the same internal slot are not the rejected alternative — they are an extension of the same per-idiomatic principle into the within-paradigm dimension where kinds have genuinely distinct vocabulary in the field.
3. **The multi-source argument doesn't apply.** A single `source.rdb` has exactly one `@kind`; `@table` and `@proc` are alternative spellings for the same single physical-name slot on that source, not parallel attrs that need to coexist on one node.

## Decision

**Within a source paradigm, use per-kind physical-name attributes when the kinds have genuinely distinct vocabulary in practitioner usage. Use a single paradigm-level attr only when all kinds share addressing semantics.**

The rule for picking per-kind vs. single:
- **Per-kind aliases** when SQL/the platform itself uses distinct DDL keywords or distinct API mechanisms for the kinds — i.e. when the practitioner mental model says "X is not a Y" (table vs. view vs. stored proc).
- **Single attr** when all kinds in the paradigm share one addressing mechanism — i.e. they're all "the same kind of identifier" semantically.

Applied to the paradigm catalog from ADR-0007:

| Paradigm | Approach | Per-kind aliases (canonical → @kind) | Notes |
|---|---|---|---|
| **`rdb`** | per-kind | `@table` → `table` (default), `@view` → `view`, `@materializedView` → `materializedView`, `@proc` → `storedProc`, `@function` → `tableFunction` | SQL itself + every ORM uses distinct names |
| **`document`** | single | `@collection` (covers `collection`, `view`) | Mongo $views address identically to collections |
| **`event`** | per-kind | `@topic` → `topic`, `@queue` → `queue`, `@subject` → `subject`, `@stream` → `stream` | Kafka/RabbitMQ/NATS/Kinesis use these terms distinctly |
| **`graph`** | per-kind | `@label` → `node`, `@edge` → `relationship` | Already specified per-kind in ADR-0007 |
| **`keyValue`** | single | `@keyspace` (covers `key`/`set`/`hash`/`list`/`table`) | All kinds live in the same keyspace; value type is the differentiator |
| **`wideColumn`** | TBD | TBD when paradigm lands | designs decided per paradigm |
| **`search`** | TBD | TBD when paradigm lands | likely `@index` (single) |
| **`vector`** | TBD | TBD when paradigm lands | likely `@collection` or `@index` (single) |
| **`timeSeries`** | TBD | TBD when paradigm lands | likely `@measurement` (single) |
| **`objectStore`** | TBD | TBD when paradigm lands | likely `@bucket` (single) |
| **`api`** | TBD | TBD when paradigm lands | likely `@endpoint` (single) |
| **`memory`** | n/a | — (in-process; no physical address) | |

### Mechanics

1. **Single internal slot.** Per-kind aliases all write to the same `physicalName` slot on the source node. The loader stores one value; the wire-format attr key on the way in/out reflects the canonical-per-kind spelling.

2. **Match-the-kind validation.** Exactly one of the kind-aware aliases per `source.<paradigm>` is permitted, and it must match `@kind`. Mismatch errors:
   - `ERR_PHYSICAL_NAME_KIND_MISMATCH` — `@table` set with `@kind: "storedProc"` (legacy aliasing supports this during migration only; see below).
   - `ERR_PHYSICAL_NAME_MULTIPLE` — two kind-aware attrs set on the same source (e.g. both `@table` and `@view`).

3. **Default resolution unchanged.** When no physical-name attr is set, the value derives from `source.@name` (if present) or the owning entity's name via the project's naming strategy (per ADR-0007 point 2). The default lands on the same single `physicalName` slot.

4. **Canonical serialization rewrites to per-kind.** The canonical serializer emits the kind-matching attr name regardless of which alias was written in source. So:
   - Input: `{ "source.rdb": { "@kind": "storedProc", "@table": "fn_x" } }` (legacy)
   - Canonical: `{ "source.rdb": { "@kind": "storedProc", "@proc": "fn_x" } }`
   This pins per-kind naming as the conformance contract going forward.

5. **Pre-1.0 legacy alias for `@table`.** The pre-existing universal-`@table` form is accepted by the loader as a legacy spelling for any rdb kind — but canonical-serialize rewrites it. After the next conformance corpus regeneration, no fixture uses `@table` with a non-`table` kind. This keeps existing in-flight branches working through the transition without permanent ambiguity.

### What does NOT change

- ADR-0007's per-paradigm principle. Different paradigms still have idiomatic attrs (`@table`/`@collection`/`@topic` etc.).
- ADR-0007's rejection of cross-paradigm generic attrs (`@locator`/`@map`/`@dbName`). Still rejected.
- The `source.<paradigm>` subtype set, `@kind` discrimination, `@role` multi-source semantics, `@schema` namespacing.
- The logical-name attribute (`name` on the source itself), which remains optional and serves as the naming-strategy default per ADR-0007 point 2.

## Consequences

**Positive**
- Metadata reads as practitioners speak. `@proc: "fn_x"` self-describes; `@table: "fn_x"` does not.
- Matches the universal industry convention across SQL standard + every major ORM.
- Single physical-name slot internally — codegen and runtime read one field; no per-kind branching at consumption time.
- Conformance contract becomes tighter: the canonical attr name now encodes the kind, eliminating a class of "did the writer mean a table or a view?" ambiguity.
- Establishes the per-kind-when-kinds-differ rule cleanly for the paradigms still to be designed (event, graph were already per-kind; this generalizes the rationale).

**Negative / costs**
- One-time cost of refactoring ~1 day per port (registering 4 new aliases for rdb: `@view`/`@materializedView`/`@proc`/`@function`; adding the match-kind validation; updating canonical-serialize).
- Conformance corpus regeneration: every existing `source.rdb` fixture with `@kind: view`/`materializedView` and a `@table` attr gets rewritten to `@view`/`@materializedView`. The wire-format LOGICAL contract is unchanged; only the canonical attr key shifts.
- A second attr-key vocabulary per paradigm to remember — but the alternative (universal `@table`) was already cognitively expensive in practice.

**Risk: scope creep into other paradigms.** This ADR specifies the rule and applies it to paradigms that are concrete enough to decide (rdb shipped, event/graph mentioned in ADR-0007). For the TBD paradigms (search, vector, timeSeries, etc.), the per-kind-vs-single decision is deferred until the paradigm's first real implementation arrives. The rule, not the table, is the contract.

## Alternatives considered (rejected)

1. **Keep `@table` universal within rdb (status quo from ADR-0007).** Internally consistent but does not match SQL standard, ORM convention, or practitioner mental model. The reader-ergonomics cost is real and accumulating. Rejected on practice-vs-purity grounds.

2. **Generic kind-neutral `@dbName` within rdb.** Was offered during the conversation that produced this ADR. Rejected for the same reason ADR-0007 rejected `@locator`: it's a single uniform word that loses the idiom every adopter expects. Stored proc isn't a "DB name" any more than it's a "table" — neither word matches what practitioners say.

3. **Per-kind attrs with the kind name as suffix (`@rdbName`, `@procName`, `@viewName`).** Mechanical and ugly. The natural attribute name is the kind-word itself (`@table`, `@view`, `@proc`), not `@<kind>Name`. Rejected.

4. **Per-kind attrs that don't share a slot (parallel attributes).** I.e. `@table` and `@view` could both be set on different sources of the same entity. Already rejected implicitly by the single-source-one-kind invariant; one source has one kind, hence one physical-name attr.

## Realization status

- **TypeScript reference:** unimplemented. Plan in FR-016 (`docs/superpowers/specs/2026-05-28-fr-016-source-rdb-name-and-kind-aliases-design.md`).
- **Java / Kotlin / C# / Python:** unimplemented. Follow TS reference; one class + one registration line per ADR-0002.
- **Conformance corpus:** regenerated after TS reference lands; all rdb-source fixtures pin per-kind canonical names.

## Conformance note

This is a wire-format change at the canonical-serialized output level (the attr key for non-table rdb kinds changes). It is **not** a logical contract change — every metadata model expressible before remains expressible, with the same loaded semantics. Conformance fixtures are regenerated atomically with the loader change; the corpus is the gate, as always.

## Cross-references

- [ADR-0007](ADR-0007-source-v2-paradigm-subtypes-multisource.md) — establishes the per-paradigm idiomatic naming principle this ADR refines.
- [ADR-0013](ADR-0013-logical-field-types-vs-physical-column-attributes.md) — the logical/physical layer split. The per-kind aliases sit firmly in the physical layer (`dbProvider`-registered).
- FR-016 — implementation plan for the rdb side, paired with the `name` attr + default-resolution closure that completes ADR-0007.
