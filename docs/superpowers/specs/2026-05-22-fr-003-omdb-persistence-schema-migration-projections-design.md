# FR-003 — Java RDB persistence, metadata-driven schema migration & dynamic projections (ObjectManagerDB on 7.0.0)

**Date:** 2026-05-22
**Status:** Design (ready for implementation plan)
**Target version:** `7.0.0` (developed as `7.0.0-SNAPSHOT`; see *Versioning & compatibility*)
**Scope:** Bring the Java `ObjectManagerDB` (OMDB) persistence engine forward onto the current `metaobjects` core, add metadata-driven schema migration, jsonb-as-value-object field support, and dynamic projection views — aligned with the cross-language metamodel and migration semantics. This is the Java half of the runtime-persistence story (TS already ships `runtime-ts` + `migrate-ts`; C# is specced separately).

## Background

The Java line ships a metadata framework + codegen (`metaobjects-metadata`, `-core`, `-codegen-*`, `-maven-plugin`) but no runtime RDB persistence. A mature persistence engine — `ObjectManagerDB` (OMDB) — exists in the sibling `metaobjects-dynamic` project (`metaobjects-om` + `metaobjects-omdb`) but is published at `6.2.6` against the **pre-restructure** core (before the loader/`MetaRoot` rework and the current metamodel: identities, relationships, the constraint system, `isArray`). It is therefore not usable against current core without a port.

OMDB already provides, today, the load-bearing pieces this work needs:
- Pluggable dialect drivers (`PostgresDriver`, `MySQLDriver`, `OracleDriver`, `MSSQLDriver`, `DerbyDriver`, `GenericSQLDriver`).
- An `Expression`/`QueryOptions` query API (composable filter, sort, range, `withLock`).
- Native-SQL execution that maps result rows back to objects: `DBOperations.executeQuery("[Type] <SQL>", args)` / `execute(...)`.
- Persistence of **any object that has a registered MetaObject** (not only `ValueObject`) via `MetaField.getObject/setObject` — so codegen'd POJOs persist without a per-class adapter.
- A schema validator (`MetaClassDBValidatorService`) that verifies each MetaObject's table/view mapping against the live DB and **creates what is missing** (tables, sequences, indexes, foreign keys, views) under an `autoCreate` flag; `PostgresDriver` implements `CREATE TABLE`/`CREATE INDEX` and `ALTER TABLE`.
- DB-mapping attributes already registered in core (`CoreDBMetaDataProvider`: `@dbTable`, `@dbColumn`, `@dbNullable`, `@dbForeignKey`, `@dbIndex`, `@dbUnique`, `@dbLength`, `@dbPrecision`, `@dbScale`, identity-level `@dbSequenceName`, …).

What does **not** exist yet, and is the substance of this FR: the port to current core, a Spring-transaction-aware connection path, jsonb value-object support, a true **diff-and-converge** schema engine (vs. today's create-if-missing), origin-driven projection-view SQL, and the codegen templates that make all of this turnkey for a consuming application.

## Cross-language alignment (durable contract vs. idiomatic surface)

The conformance suite (`spec/conformance-tests.md`) is explicit: **runtime / ObjectManager behavior is out of cross-language parity scope** — each language ships an idiomatic runtime (TS layers `ObjectManager → IPersistenceDriver → Kysely/Drizzle`; C# is heading toward `ObjectManager → SqlKata/ADO.NET`). Java using an OMDB-derived `ObjectManager` is therefore **correct and not a divergence**. What must stay identical across TS/Java/C# is the *durable contract*:

- **Metadata vocabulary** — `source.dbTable`/`source.dbView`, `origin.passthrough`/`origin.aggregate`, `object.entity`/`object.value`/`object.base`, the `@db*` attrs (already in core + fixtures for `source-*` and `origin-*`).
- **Identity strategy** — `@generation: "increment" | "uuid" | "assigned"` on the primary identity drives who produces the PK (driver / runtime / caller). Java must honor the same vocabulary.
- **Migration semantics** — deterministic diffs, forward-only emission, `@previousName` as the rename hint (rename is never inferred from a diff — that path is silent data loss), dry-run/verify before apply.

This FR also heeds the lessons recorded in the C# persistence design: **harvest** OMDB's dialect drivers, expression API, bulk-ops, explicit transaction control, and schema-generation engine; **avoid deepening** its known anti-patterns (mapping state cached on `MetaObject` instances; `parseField()` if/else type ladders; mandatory manual `getConnection()`/`releaseConnection()` lifecycle), and — most importantly — **do not bolt migration application into the CRUD runtime**. The schema engine is reused, but it is surfaced through a decoupled `meta migrate` verb set, not auto-applied as a side effect of persistence.

## Capabilities

### 1. Port the dynamic/persistence modules onto current core; re-unify the version line
Bring `dynamic` (`ValueObject`/`DataObject`), `om`, and `omdb` onto `7.0.0` core: new loader/`MetaRoot` access, the identity/relationship metamodel, constraint registration, and current `MetaField` accessors. `dynamic` is **required** scope — `ValueObject` is load-bearing for OMDB reads/writes, projections, and jsonb-as-value-object.

**Stranded-module principle.** Because the core API changed (loader/`MetaRoot`, metamodel), any module left at `6.2.6` against the old core is unusable alongside `7.0.0` core — there is no working half-ported state. So every module that stays *alive* moves to `7.0.0`; anything not moving is **explicitly archived/deprecated**, not silently left at `6.2.6`.

| Currently-`6.2.6` module | Verdict |
|---|---|
| `dynamic` (`ValueObject`/`DataObject`) | Port — required |
| `om` (ObjectManager base) | Port — required |
| `omdb` (ObjectManager :: RDB) | Port — required |
| `omnosql` (NoSQL) | Deferred — revisit (port or archive) in a later FR |
| `web` / `web-spring` | Deferred — revisit (port or archive) in a later FR |
| `demo` | Deferred — revisit (port or drop) in a later FR |

The required modules — `metadata`, `core`, `codegen-*`, `maven-plugin`, `core-spring`, `dynamic`, `om`, `omdb` — ship at a single `7.0.0`, collapsing the current `6.3.1`/`6.2.6` skew. **Decided: consolidate `dynamic`/`om`/`omdb` into this monorepo (`server/java`) as one Maven reactor at one `7.0.0`** — no cross-repo SNAPSHOT dance, no lockstep releases. The deferred modules (`omnosql`/`web`/`web-spring`/`demo`) stay dormant at `6.2.6` until a later FR decides their fate; they are not usable against `7.0.0` core in the interim, by design.

### 2. Spring-transaction-aware connection
`ObjectConnectionDB(Connection)` already accepts an externally-owned connection. Ship (likely in `metaobjects-core-spring`) a thin adapter that wraps `DataSourceUtils.getConnection(dataSource)` and does **not** close the connection (Spring owns the lifecycle), so OMDB operations join the caller's active `@Transactional` scope — including `REQUIRES_NEW` and pessimistic boundaries. No second, out-of-transaction connection.

### 3. jsonb fields modelled as typed value objects (opt-in)
A jsonb column may be either opaque JSON **or** declare a nested MetaObject as its value type. When modelled, the value is a **code-generated, mutable, typed POJO** (the default — real objects, IDE/type-safe), with `ValueObject` (the dynamic Map container) as the **fallback** for intentionally-open/dynamic shapes:

```jsonc
// opaque
{ "field.object": { "name": "rawConfig", "@dbColumn": "raw_config", "@dbType": "jsonb" }}

// modelled — value is a generated typed POJO (list/map per cardinality)
{ "field.object": { "name": "dispositions", "@dbColumn": "dispositions",
    "@dbType": "jsonb", "@objectRef": "Disposition", "@isArray": true, "@keyedBy": "subjectId" }}
```

`PostgresDriver` gains a jsonb column type + a Jackson-backed converter that resolves the field's referenced MetaObject to its **bound Java class** (via the binding registry, §8 / ADR-0001) and (de)serializes the typed POJO ⇄ jsonb; cardinality via `@isArray` (`List<T>`) and optional `@keyedBy` (`Map<K,T>`); `ValueObject` when no class is bound. **Mutability matters:** these objects are read-modify-write (e.g. `realm.getMechanics().setX(…)`), not read-only DTOs — so generated jsonb value types are **mutable POJOs**, not immutable records. Because in-place mutation leaves the parent's field reference unchanged (so OMDB's dirty-field check can't detect it), **jsonb fields are always (re)serialized on `updateObject`** (deep-compare is a later optimization). This shares one modelling path with projections (below).

### 4. Metadata-driven schema migration (decoupled `meta migrate`)
Extend `MetaClassDBValidatorService` + drivers from *create-if-missing* to a **diff-and-converge** engine: add tables/columns/indexes/FKs/sequences/views and additive ALTERs (widen type, add nullable/defaulted column). Surface it through a cross-language-aligned verb set, **not** as boot-time auto-apply:

- `emit` — diff metadata vs. a target DB → forward-only SQL script (reviewable artifact; doubles as SQL-visibility for debugging).
- `verify` — drift detection, non-zero exit on drift (CI gate).
- `diff` — human-readable diff, writes nothing.
- `apply` — execute (additive changes safe to auto-apply; **destructive/ambiguous changes — drop, rename, narrowing — require `@previousName` or an explicit hand-authored step, never inferred**; data migrations get an explicit hook).

A consuming app adopts its existing schema as the baseline; metadata must reproduce it exactly (schema-equivalence) before any external migration tool is retired.

### 5. Dynamic projection views
A projection is `object.value`/`object.entity` + `source.dbView`, with fields carrying `origin.passthrough` (cross-entity ref) or `origin.aggregate` (`count`/`sum`/`avg`/`min`/`max` via dotted `@via`/`@of`). OMDB already creates views from `ViewDef` and verifies read mappings; add the **origin→`CREATE VIEW` SQL deriver** so view SQL is generated when expressible, falling back to explicit `dbViewSQL` only when it is not. Projection results materialize as `ValueObject`s (the same container used for opaque/value-object reads), so consumers can blend projected DB data with app-side values.

### 6. Codegen templates
Mustache templates/generators (build-time, via the maven-plugin) for: entity base classes (POJO mapped via `PojoMetaObject`, no business logic), per-entity SQL-name constants (`Tables`/`Columns` — keep residual native SQL rename-safe + drift-checkable), **typed mutable jsonb value-object POJOs** (§3), projection value-object classes, an OMDB-backed repository base (CRUD via `Expression`/`QueryOptions`; advanced queries via `dbViewSQL`/`executeQuery`), and **one `MetaDataTypeProvider` per generated package that registers its `FQN → class` bindings** (§8 / ADR-0001), `ServiceLoader`-discovered. Generated artifacts carry no business logic; consumers extend them.

### 7. Conformance fixtures
Extend the existing `source-*`/`origin-*` corpus to cover the new vocabulary surfaced here (`@generation`, `@previousName`, jsonb value-object fields, projection origin→view derivation at the **metamodel** level). A full migration-output conformance corpus (byte-identical SQL across languages) is flagged **future** (consistent with the C# design); v1 asserts vocabulary + loader/serializer parity and diff *determinism* per language.

### 8. Metadata→Java-class binding registry (per ADR-0001)
OMDB instantiates **typed objects** — entities, jsonb value-objects (§3), and projection results — by resolving a MetaObject's FQN to its concrete Java class. Per **[ADR-0001](../../../spec/decisions/ADR-0001-cross-language-type-binding.md)**, this is a **build-time, domain-sliced, FQN-keyed registry — never runtime reflection** (`Class.forName` is AOT/native-image-hostile; the cross-language contract forbids it). Java realization: codegen emits **one `MetaDataTypeProvider` per generated package** that registers its `FQN → Class` bindings; `ServiceLoader` discovers and merges them across packages/jars (the same mechanism core already uses for its 8 type providers). OMDB consults the merged registry to pick the class for `newInstance()`/jsonb deserialization, falling back to `ValueObject` when no class is bound. This FR builds the **runtime registry contract** (the registry API + OMDB consulting it, tested with hand-registered bindings); the codegen that *emits* the per-package providers ships with the codegen templates (§6). The deferred metadata overlay (`@object` FQN map) is replaced by this generated, compile-checked registration — and never reappears as a hand-maintained file.

## Versioning & compatibility

`6.x → 7.0.0`, by SemVer (and OSGi semantic versioning, since the project ships bundles): a major bump is mandated by **breaking public-API changes**, regardless of how much additive work rides along.

- **Breaking surface:** loader/`MetaRoot` access changes; OMDB re-coordination/re-packaging (it currently publishes `com.metaobjects.dynamic.*` at `6.2.6`).
- **Additive (would alone be a minor):** schema migration, projection-view derivation, jsonb value objects, codegen templates.
- **Re-unification:** all modules ship at one `7.0.0`, ending the `6.3.1`/`6.2.6` skew.
- **Cadence:** develop on `7.0.0-SNAPSHOT`; cut a `7.0.0-M1`/`-RC` validated by the first real Java consumer migration before final `7.0.0`. Drawing the breaking boundary at `7.0.0` now — ahead of public publish — is cheaper than breaking pinned `6.3` consumers later.

## Out of scope
- NoSQL (`omnosql`) port.
- A from-scratch TS-mirror runtime rewrite for Java — OMDB-derived `ObjectManager` is the intentional Java-idiomatic runtime.
- EF/Drizzle-style entity-class codegen *targets* beyond the POJO/repository bases above.
- Down migrations (forward-only, matching the cross-language convention).
- Byte-identical cross-language migration SQL corpus (future).

## Open questions (resolve during planning)
1. **Apply model:** boot-time auto-converge vs. emit-and-apply-via-tool. (The cross-language direction favors decoupled/reviewed; a consumer may still opt into auto-apply of additive-only changes in dev.)
2. **Destructive-change policy:** `@previousName` rename hints + explicit data-migration steps — required gating before `apply` will touch a drop/narrowing.
3. **jsonb converter details:** registration point, null/empty handling, `@keyedBy` map semantics.
4. **UUID modelling:** dedicated `uuid` field subtype vs. `field` + `@dbType=uuid` attr (cross-language vocabulary decision).
5. **v1 ALTER aggressiveness:** which additive ALTERs are in scope; where the line to "emit a script for a human" sits.
6. **Deferred-module fate (later FR):** when and whether `omnosql`/`web`/`web-spring`/`demo` get ported to `7.0.0` or archived. (Consolidation into the monorepo is decided; this is the only residual structural item, and it is out of scope for this FR.)

## Testing
- Loader/serializer **conformance fixtures** for the new vocabulary.
- **Diff determinism:** same metadata + same DB → identical emitted script (the property EF infamously fails).
- **Schema round-trip:** create-from-metadata → introspect → equals metadata.
- **jsonb round-trip:** `ValueObject` ⇄ jsonb (single, list, keyed-map).
- **Spring transaction:** OMDB ops join an ambient `@Transactional` scope (incl. rollback).
- **Dialect tests** against Postgres (primary); Derby for fast in-memory.

## Cross-references
- TS persistence reference: `typescript/packages/runtime-ts/`.
- TS migration reference: `typescript/packages/migrate-ts/`.
- C# persistence/tool direction: `docs/superpowers/specs/2026-05-20-csharp-tool-and-metamodel-extensions-design.md` (and the superseded `…-csharp-rdb-persistence-design.md`).
- Metamodel vocabulary: `spec/metamodel.md`; conformance contract: `spec/conformance-tests.md`; wire format: `spec/wire-format.md`.
- Legacy OMDB source surveyed for the port: the sibling `metaobjects-dynamic` project (`om/`, `omdb/`).
- Roadmap context: `spec/roadmap.md` (H3 Java port; H4 Java codegen target; H5 first Java consumer migration).
