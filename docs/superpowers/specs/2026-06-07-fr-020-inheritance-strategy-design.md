# FR-020 — `@inheritance` persistence strategy (single-table vs joined)

**Status:** Design (proposed — NOT scheduled; sequenced AFTER FR-017 TPH lands on every port).
**Applies to:** all five language ports (TypeScript reference + Java / Kotlin / C# / Python).
**Depends on:** [FR-014](2026-05-28-fr-014-tph-discriminator-design.md) (discriminator metamodel) + [FR-017](2026-06-02-fr-017-tph-polymorphic-codegen-design.md) (TPH polymorphic codegen). This FR generalizes the inheritance-with-persistence story those two established for the single-table case.
**Related ADRs:** [ADR-0013](../../../spec/decisions/ADR-0013-logical-field-types-vs-physical-column-attributes.md) (logical vs physical), [ADR-0015](../../../spec/decisions/ADR-0015-single-shared-migrate-engine.md) (TS-only schema migration), [ADR-0023](../../../spec/decisions/ADR-0023-strict-metadata-provenance.md) (no made-up/blob attrs).

## Why this doc exists

FR-014/FR-017 shipped **table-per-hierarchy (TPH)**: an `object.entity` with `@discriminator` + subtype `@discriminatorValue`s persisted in ONE physical table, subtype-only columns nullable. That is the single, implicit inheritance strategy today.

Every major ORM also offers a **joined** (a.k.a. table-per-subclass) strategy — JPA `@Inheritance(JOINED)`, EF Core TPT (table-per-type), SQLAlchemy joined-table inheritance, Hibernate `JOINED`. In joined inheritance the base entity owns a base table and **each concrete subtype owns its own table** carrying only its added columns, joined to the base by a shared primary key. The trade vs TPH:

| | TPH (FR-014) | Joined (this FR) |
|---|---|---|
| Tables | one | base + one per subtype |
| Subtype columns | nullable on the shared table (sparse/wide) | NOT NULL on the subtype's own table |
| Read a subtype | single-table, discriminator filter | base ⋈ subtype join |
| Polymorphic read | one scan | base + per-subtype joins / union |
| Schema normalization | denormalized | normalized |
| Add a subtype | widen the shared table | new table (no shared-table change) |

Adopters with many subtypes, wide subtype-specific columns, or strict NOT-NULL requirements want joined; adopters wanting simple polymorphic reads want TPH. Supporting both — selected per hierarchy by a typed attr — is the standard ORM contract.

## What this is NOT (the legacy trap)

The Java `omdb` carries a **dead, pre-metamodel** joined-inheritance mechanism (`InheritanceRef` / `InheritenceDef`, configured by an untyped `INHERITANCE_REF` **`Properties` blob attr** with `joiner` / `superClass` / `superJoiner`). It is wired into `SimpleMappingHandlerDB` + `GenericSQLDriver` but **fed by nothing** — no metadata, fixture, or test sets the blob; no other port has any analog. It predates FR-014, ADR-0023 (strict provenance forbids untyped blob attrs), and the SP-G cross-port metamodel manifest. It is being **deleted** (see "Legacy removal"). This FR is the *proper* replacement: a typed, conformance-gated strategy attr — NOT a cross-port of the blob.

## Proposed metamodel

A single optional typed attr on the discriminator base `object.entity`:

```
@inheritance: "single_table" | "joined"   # default "single_table"
```

- Lives on the **base** (the entity carrying `@discriminator`), alongside it. Absent ⇒ `single_table` (today's TPH — fully back-compatible; FR-017 output is unchanged).
- A closed `field.enum`-style value set (ADR-0023 typed attr, registered on `MetaObject` next to `ATTR_DISCRIMINATOR`); cross-port-canonical via the SP-G manifest.
- Reuses the EXISTING `@discriminator` / `@discriminatorValue` vocabulary unchanged — joined still needs a discriminator column on the base for polymorphic dispatch (the join target is chosen by the discriminator). No new per-subtype attrs: a subtype's own table name derives from its `source.rdb @table` (or the entity-name default), and the join key is the base's primary identity.

No `source.rdb @discriminatorColumn` / blob / joiner attrs — the layer + vocabulary are already correct from FR-014.

## Per-port realization (idiom table)

| Port | single_table (FR-017, shipped) | joined (this FR) |
|---|---|---|
| **TypeScript** | one Drizzle table; discriminated union | base + per-subtype Drizzle tables; read = base ⋈ subtype; polymorphic = base + per-subtype joins |
| **Java** | one table; discriminator filter in omdb | JPA `@Inheritance(JOINED)` shape; omdb multi-table read/write across the PK join |
| **Kotlin** | one table; sealed + Exposed | per-subtype Exposed tables joined on PK |
| **C#** | EF `HasDiscriminator` (TPH) | EF TPT (`ToTable` per subtype) |
| **Python** | one table; dict runtime scope | SQLAlchemy joined-table inheritance; base + subtype tables |

## Hard parts (why this is a large, deliberate effort)

1. **Schema is TS-only (ADR-0015).** `migrate-ts` must emit the joined multi-table DDL (base + per-subtype tables, shared-PK FKs, the discriminator on the base) + drift rules — strictly more than TPH's single `CREATE TABLE`. Every port then executes that committed schema.
2. **Runtime multi-table read/write in every port.** create = insert base row + subtype row in one tx; read = join; polymorphic read = base + per-subtype joins/union; update/delete = both tables. This is materially larger than TPH's single-table scoping.
3. **Conformance.** New `fixtures/persistence-conformance/queries/joined-*.yaml` + `fixtures/api-contract-conformance/joined/` corpora, authored TS-green first, then per-port — mirroring the FR-017 tiered rollout.

## Tiered delivery (mirrors FR-017)

1. Metamodel: register `@inheritance` typed attr + loader validation (default single_table; `joined` requires `@discriminator` + ≥1 subtype) + SP-G manifest entry. **All ports.**
2. TS reference: migrate-ts joined DDL + runtime joined read/write + codegen + both conformance corpora.
3. Per-port fan-out: Java / Kotlin / C# / Python joined runtime + codegen idiom.
4. Conformance: joined corpora byte-equivalent cross-port.

## Recommendation / sequencing

**Do not start until FR-017 TPH is green on all five ports.** TPH is the common case and the simpler cross-port contract; finish it first. Schedule FR-020 only on real adopter demand for normalized/NOT-NULL subtype storage — the metamodel hook (`@inheritance` default `single_table`) is designed here so adding `joined` later is additive, never a breaking change to existing TPH metadata.

## Legacy removal (prerequisite, independent of scheduling)

The dead `omdb` `InheritanceRef`/`InheritenceDef` blob path is removed as part of finishing Java TPH, so Java carries exactly ONE inheritance model (FR-014 typed attrs). This FR is the sanctioned future home for joined inheritance; the blob path is not resurrected.
