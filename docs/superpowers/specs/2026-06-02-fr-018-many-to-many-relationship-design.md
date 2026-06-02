# FR-018 — Many-to-Many Relationship: slim vocabulary (`through`/`symmetric`) + cross-port codegen + conformance

**Date:** 2026-06-02
**Renumber note:** originally drafted + Phase 1/2 merged as **FR-017**; renumbered to **FR-018** on 2026-06-02 (a sibling session had a prior claim on FR-017 for TPH polymorphic codegen, reserved in the 2026-05-31 metamodel-batch plan). The merged Phase-1/Phase-2 commits keep their immutable `FR-017` labels; all work from Phase 3 onward uses **FR-018**.
**Status:** Phase 1 (vocab) + Phase 2 (runtime resolvers) MERGED to main (`f1e44b7a`); Phase 3 (codegen/REST/docs) + Phase 4 pending.
**Relates to:** the SP-G registry-conformance finding that `joinEntity`/`joinFields` is TS-runtime-only, has zero codegen + zero conformance coverage, and is largely redundant with `identity.reference` (the cross-port SSOT for FK direction). Supersedes the original SP-G Java-reconciliation Unit-4 "Java adopts joinEntity/joinFields" step.

## Problem

The current M:N relationship vocabulary is weak on every axis:

- **Redundant.** `@joinFields: [sourceFK, targetFK]` re-states FK field names that the junction entity's `identity.reference` children already carry (`@fields` + `@references`). It exists today only because the one authored M:N example skips declaring the junction's references.
- **Physically named.** `@joinEntity` reads as a SQL join-table; the value is a metaobject *entity* name. ORM precedent (Rails `through:`, EF `UsingEntity`, UML association class) favors a relationship-semantic word.
- **TS-runtime-only.** Consumed solely by `runtime-ts/src/n2m-resolver.ts` + `object-manager.ts`. **No port's codegen emits M:N** (every relation generator `continue`s on `cardinality != one`). C#/Python register the attrs but nothing reads them; Java/Kotlin don't even register them.
- **No conformance coverage.** Zero M:N scenarios in any corpus; the only example is a TS runtime unit fixture.
- **Cannot express symmetric self-relations.** Directed self-join (`follows`, `blocks`) is barely expressible; undirected (`friends`) is not expressible at all.

This is the right time to fix it: it is shipped but unused vocabulary, pre-GA, and **before** Java/Kotlin lock in the redundancy.

## The slim vocabulary

A M:N relationship is `relationship.<subtype>` with `@cardinality: "many"` and:

| attr | required? | meaning |
|---|---|---|
| `@objectRef` | **required** | the TARGET entity (non-derivable) |
| `@through` | **required** | the JUNCTION/through entity — a third entity distinct from source and target (non-derivable; renamed from `@joinEntity`) |
| `@sourceRefField` | optional | names the source-side FK field on the junction; **required only** for *directed* self-join / otherwise-ambiguous junctions |
| `@symmetric` | optional (boolean) | the relation is undirected; resolution unions both junction FK columns. **Valid only** when source == target (self-join). Mutually exclusive with `@sourceRefField` |

**Removed:** `@joinFields` — derived from the junction entity's two `identity.reference` children.

`@cardinality`, `@onDelete`, `@onUpdate`, and the three subtypes (`association`/`aggregation`/`composition`) are unchanged.

### The junction-entity SSOT requirement

A M:N junction entity MUST declare two `identity.reference` children — one per FK side (`@fields: [<fk>]`, `@references: <Entity>`). This is exactly how 1:N FK direction is already declared (`find-reference.ts` is the SSOT). The relationship's FK fields are then **derived**, not restated. (The existing `n2m-shape.json` test fixture, whose junction uses bare FK fields + a composite PK with no references, is updated to declare them.)

## Resolution semantics

Given a M:N relationship on source `S` (`@objectRef: T`, `@through: J`), let `J` declare references `rS` (→`S`) and `rT` (→`T`):

1. **Hetero (S ≠ T) — fully derived, zero extra config.** `sourceFK = rS.fields[0]` (the reference whose `@references` resolves to `S`); `targetFK = rT.fields[0]` (resolves to `T`). Query `J WHERE sourceFK = s.pk`, then load `T` by `targetFK`.
2. **Directed self-join (S == T, `@sourceRefField` set).** Both references resolve to `S` → ambiguous. `@sourceRefField` names the source-side FK; the *other* reference is the target side. The inverse relationship sets the opposite `@sourceRefField`. Deterministic.
3. **Symmetric self-join (S == T, `@symmetric: true`).** Union both directions: `J WHERE srcFK = s.pk OR tgtFK = s.pk`; for each row, the "other" column (the one ≠ `s.pk`) is the related id. Returns both directions from single-row storage (no double-insert). `@sourceRefField` not used.
4. **Ambiguous + neither set → loader/resolver ERROR.** When `S == T` and neither `@sourceRefField` nor `@symmetric` is present, fail loudly (ERR-class, ADR-0009 style) — strictly safer than today's silent arbitrary pick.

### Validation rules (loader, every port)

- `@through` + `@objectRef` required when `@cardinality: "many"` and the relationship models M:N (i.e. a junction is involved). (1:N stays as-is — no `@through`.)
- `@symmetric: true` is valid only when `@objectRef` == the declaring entity (self-join). Error otherwise (`ERR_BAD_ATTR_VALUE`).
- `@symmetric` and `@sourceRefField` are mutually exclusive (error if both).
- The junction named by `@through` must exist and declare two `identity.reference` children; `@sourceRefField`, if present, must match one of them. (Deferred-resolution validation, after all files load — like `extends`.)
- `@symmetric`/`@sourceRefField` are invalid on non-M:N (1:N / `@cardinality: one`) relationships.

## Cross-port codegen (POJOs → repositories → documentation)

M:N is currently skipped by all codegen; this FR makes every port emit idiomatic M:N support, verified by the FR-007 semantic codegen-conformance corpus (semantic parity, not byte-identity). Per port, M:N generates:

- **Entity / POJO navigation.** A collection-valued navigation member on the source entity for the related target (e.g. TS `tags: Tag[]`, C# `ICollection<Tag>`, Java POJO/`ValueObject` getter, Kotlin `List<Tag>`, Python list). For symmetric, a single self-referential collection.
- **ORM wiring (where the port has an ORM layer).**
  - TS Drizzle: a `relations()` many-to-many through the junction table + a typed query helper.
  - C# EF Core: `HasMany().WithMany().UsingEntity<Through>(...)` with explicit FK config (and source-side selection for self-join).
  - Java `codegen-spring`: the junction navigation + a repository finder that joins through the junction (and DTO field). JPA `@ManyToMany`/`@JoinTable` where the Spring/JPA layer applies, else a repository query.
  - Kotlin `codegen-kotlin`: Exposed many-to-many through the junction table + a query helper.
  - Python: SQLAlchemy relationship `secondary=<junction>` + Pydantic nested.
- **Filter/sort + API contract.** M:N navigation IS exposed in the generated REST contract (v1 decision) — traversal of the join over HTTP, covered by the api-contract corpus in both lanes.
- **Runtime resolver (every port).** A generic, metadata-driven M:N query resolver in each runtime layer (TS `runtime-ts` — update existing; Java OMDB; Kotlin Exposed; Python ObjectManager; C# EF), so M:N traversal works at runtime without generated code. The generated repository join is emitted in addition.
- **Documentation.** Doc-gen (JSDoc / XML-doc / Postgres `COMMENT ON` / Mermaid) describes the M:N edge through the junction (and marks symmetric). `notes` stays internal-only per the documentation-provider contract.

The per-port output is idiomatic and **not** byte-identical; FR-007's semantic manifest asserts parity (the navigation member exists, points at the right target through the right junction, with the right cardinality + symmetry).

## Conformance — test every scenario

New M:N fixtures across the relevant corpora, exercising all three resolution modes:

- **Metamodel / registry-conformance:** the slim vocabulary (`through`/`sourceRefField`/`symmetric`; no `joinFields`) registered identically across ports; the validation errors (symmetric-on-hetero, both-disambiguators, missing-junction-references) as `error-*` fixtures.
- **Persistence-conformance:** a hetero M:N, a directed self-join, and a symmetric self-join — schema (junction table + two FKs) + query resolution through the junction, run on every port against Testcontainers Postgres.
- **API-contract-conformance:** if M:N navigation is exposed in the generated API, a scenario per mode (both reference-server + generated-artifact lanes).
- **Codegen-conformance (FR-007):** the semantic manifest asserts each port emits the M:N navigation + ORM wiring for all three modes.
- **Render/doc-conformance:** doc-gen output for a M:N relationship (incl. symmetric) byte-identical across the ports that ship doc-gen.

The kitchen-sink M:N fixtures double as exercisers that help burn down SP-G's untested-vocabulary backlog for `relationship.*`.

## Migration / breaking-change handling

This changes shipped cross-port vocabulary. Per the project's **no-backwards-compat-hacks** rule:

- Rename `@joinEntity` → `@through`; remove `@joinFields` (derive); add `@sourceRefField` + `@symmetric`. Update TS/C#/Python registration + the TS runtime resolver + the SP-G registry canonical (`fixtures/registry-conformance/expected-registry.json`).
- Java/Kotlin register the **final** slim vocabulary (never the interim `joinEntity`/`joinFields`) — this replaces the SP-G Java-reconciliation Unit-4 join-vocab step.
- Coordinate with the SP-G canonical: land FR-018's relationship-vocabulary change **before** SP-G merges (or as a coordinated canonical update), so the registry gate reflects the slim vocabulary.
- Update the one authored M:N fixture (`n2m-shape.json`) + any docs naming `joinEntity`/`joinFields` (CLAUDE.md cross-language-porting section, spec/metamodel docs).

## Out of scope / non-goals

- **Symmetric storage strategies beyond union-on-read** (e.g. enforced canonical ordering, double-row storage) — union-on-read is the chosen model; others are future.
- **M:N through a junction carrying extra payload fields surfaced as relationship attributes** (association-class attributes) — the junction is a normal entity; its extra fields are accessible as the junction entity, not folded into the M:N navigation. Future if needed.
- **Polymorphic / many-target M:N.** Single target entity per relationship.
- **Undirected hetero relations.** `@symmetric` is self-join-only by definition.

## Definition of done

- Slim vocabulary (`through`/`sourceRefField`/`symmetric`, no `joinFields`) registered + validated identically in all five ports; SP-G registry canonical updated + green.
- Resolution implemented for all three modes via a generic runtime M:N resolver in every port (TS/Java/Kotlin/Python/C#).
- M:N codegen emitted by every port (entity navigation + ORM wiring + repository join + REST traversal + docs), FR-007 semantic-parity-gated.
- Conformance: hetero + directed-self-join + symmetric scenarios green across metamodel/registry, persistence, api-contract (both lanes), codegen, and doc corpora; the validation `error-*` fixtures green.
- Docs updated (CLAUDE.md, metamodel spec); no `joinEntity`/`joinFields` references remain.

## Resolved scope decisions (2026-06-02 review)

1. **REST exposure — IN v1.** M:N traversal is part of the generated REST contract. The api-contract-conformance corpus gets M:N scenarios in BOTH lanes (reference-server + generated-artifact-over-HTTP) for all three resolution modes.
2. **Runtime M:N resolvers — IN v1, all ports.** Every port with a runtime query layer gets a generic, metadata-driven M:N resolver mirroring TS's `n2m-resolver`: TS (`runtime-ts`, update existing), Java (OMDB), Kotlin (Exposed), Python (ObjectManager), C# (EF). M:N traversal works at runtime without generated code; the generated repository join is ALSO emitted. Persistence-conformance exercises the runtime resolver on every port against Testcontainers Postgres.
3. **Naming — `@through`** (Rails-style) confirmed.
