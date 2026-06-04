# SP-H Field-Subtype Hardening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Fresh subagent per unit + spec-compliance review + code-quality review + simplifier, then merge forward. Steps use `- [ ]`. TDD throughout. Cross-port porting principle: study the existing per-port implementation before changing it.

**Goal:** Every concrete `field.*` subtype works end-to-end (native type + DB column + serialization + WRITE+read persistence round-trip + codegen), is tested, and is conformance-gated, in all 5 ports. Cut the dead stubs; make the shared persistence corpus gate writes, not just reads.

**Architecture:** Keystone first — add a runtime **WRITE** round-trip to the persistence-conformance corpus (today it seeds via raw SQL and only reads), which gates every port's write codec and would have caught byte/short, the Java timestamp-write hazard, and native-uuid-write. Then cut the dead stubs, fix the per-port correctness defects (all gated by the new write corpus), reconcile filter-ops cross-port, and close coverage holes.

**Tech stack:** the 5 ports' field registration + type mappers + DB column mappers + write codecs (OMDB `JdbcCodecs` / Drizzle / EF / Exposed / SQLAlchemy) + the shared corpora (`fixtures/conformance/`, `fixtures/persistence-conformance/`, `fixtures/registry-conformance/`). Testcontainers Postgres for the round-trips.

**Spec:** `docs/superpowers/specs/2026-06-03-sp-h-field-subtype-hardening-design.md` (the audit gap-matrix + resolved decisions). **Per-unit acceptance = the relevant conformance corpus green.**

---

## Phase 1 — Cuts + the write-path keystone

### Unit 1: Cut `field.class` from all ports + canonical
**Files:** field registration + type/column mappers + constants in all 5 ports; `fixtures/registry-conformance/expected-registry.json` + `coverage-report.json`.
- [ ] Verify zero consumers (grep all ports/fixtures/adopters — the audit found none; `field.object`+`@object` is the replacement). Remove `field.class` subtype + `ClassField`/class arms (Java `ClassField` + `SimpleMappingHandlerDB`/`SpringTypeMapper` throw-arms; Kotlin `KotlinTypeMapper`; TS `column-mapper`/`migrate` text-vs-jsonb both; C# `CSharpNaming` string arm; Python `_SCALAR` class entry). Regenerate canonical (−1 subtype) + coverage report. All 5 registry gates green.
- [ ] Review + simplify gate. Commit `feat(metadata): SP-H Unit1 — cut dead field.class subtype (replaced by field.object+@object)`.

### Unit 2: Bare `field.object` (no `@objectRef`) → loader error (ADR-0013)
**Files:** the object-storage validation pass in all 4 loader ports (TS `validation-passes.ts`, Java `ValidationPhase`, Python `validation_passes.py`, C# `ValidationPasses.cs`); `fixtures/conformance/error-field-object-no-object-ref/`; the error-code registries.
- [ ] TDD: add the shared `error-field-object-no-object-ref` fixture (a `field.object` with no `@objectRef` → a new/generalized `ERR_OBJECT_FIELD_WITHOUT_OBJECT_REF`, message pointing to `@dbColumnType: jsonb` for open maps). Implement the validation in each loader so `field.object` REQUIRES `@objectRef` (today only `@storage`-without-`@objectRef` errors). This fixes the C# silent-field-drop (rejected at load instead). Keep downstream codegen throws (Java/Kotlin mappers) as defense-in-depth.
- [ ] All 5 ports load the fixture green (error matches). Review + simplify gate. Commit `feat(metadata): SP-H Unit2 — require @objectRef on field.object (ADR-0013); error not silent-drop/throw`.

### Unit 3: Persistence-conformance WRITE round-trip (the keystone) — TS reference
**Files:** `fixtures/persistence-conformance/` — a new `op: roundtrip` scenario type (insert a row via the port's runtime/ORM → read it back → assert the normalized value), covering every persistable subtype (string/int/long/double/float/decimal/boolean/date/time/timestamp/currency/enum/uuid/object-with-objectRef); the TS persistence runner + `runtime-ts` insert path; corpus README.
- [ ] TDD: author the `roundtrip` scenarios + the verb in the shared runner contract; implement it in the TS runner (Drizzle/Kysely insert-then-read). Run TS persistence-conformance green against Testcontainers PG — every subtype round-trips through the TS runtime WRITE path. Document that the other ports' runners implement the verb in their units (they'll be red on roundtrip until then — expected on-branch).
- [ ] Review + simplify gate. Commit `feat(conformance): SP-H Unit3 — persistence-conformance WRITE round-trip (op:roundtrip) + TS runtime write path`.

## Phase 2 — Per-port write codecs + correctness fixes (gated by Unit 3)

### Unit 4: TS — decimal dataType + roundtrip green
- [ ] Reclassify `field.decimal` off `DATA_TYPE_DOUBLE` (string-exact; add `DATA_TYPE_DECIMAL` or map to the string dataType) so `@default` coercion is lossless (`meta-field.ts`/`data-converter.ts`). Reconcile the TS `column-mapper` (`text`) vs `migrate-ts` (`jsonb`) object-column divergence surfaced in Unit 1. TS roundtrip + metadata + codegen green. Review + simplify. Commit `feat(codegen-ts): SP-H Unit4 — decimal string-exact dataType + object-column codegen/migrate parity`.

### Unit 5: Java — write codecs + Spring codegen throw
**Files:** OMDB `JdbcCodecs` (+ codec classes), `SpringTypeMapper`, `SimpleMappingHandlerDB`.
- [ ] Add dedicated `TimestampCodec` (java.util.Date→`setTimestamp`); dedicated codecs (or correct typed `setObject`) for `currency`(long)/`enum`(string)/`uuid`(native PG `uuid` — handle `setObject` typing / `stringtype`); add a `TimeField` arm to `SpringTypeMapper` (field.class arm gone with Unit 1). Java persistence-conformance roundtrip green (Testcontainers) — incl. native-uuid + timestamp WRITE. Review + simplify. Commit `feat(omdb): SP-H Unit5 — dedicated timestamp/currency/enum/uuid write codecs + fix Spring field.time codegen`.

### Units 6–8: C# / Python / Kotlin — wire the roundtrip verb + verify writes
For EACH port (one unit): implement `op: roundtrip` in the port's persistence runner (insert-via-EF/SQLAlchemy/Exposed → read-back → assert), confirm every subtype's WRITE codec round-trips green against Testcontainers PG; fix any write-path defect the roundtrip surfaces.
- [ ] **Unit 6 — C#:** EF insert path; confirm enum/uuid/decimal/timestamp converters round-trip on write; bare-object now errors at load (Unit 2) — confirm no silent-drop. Commit `feat(csharp): SP-H Unit6 — C# persistence write round-trip + write-path fixes`.
- [ ] **Unit 7 — Python:** ObjectManager insert path; confirm decimal/uuid/temporal/jsonb write round-trip. Commit `feat(python): SP-H Unit7 — Python persistence write round-trip + write-path fixes`.
- [ ] **Unit 8 — Kotlin:** Exposed insert path; add the `KotlinTypeMapper` `else`-branch negative test (guard the next byte/short); confirm every subtype write round-trips. Commit `feat(codegen-kotlin): SP-H Unit8 — Kotlin persistence write round-trip + mapper else-guard test`.

## Phase 3 — Filter-op reconciliation + coverage holes

### Unit 9: Filter-operator cross-port reconciliation
**Files:** the op-band source in each port (TS `query-constants.ts` `OPS_BY_SUBTYPE`, C# `QueryConstants` + `FilterAllowlistGenerator`, Python `_ops_for_subtype`, Java + Kotlin equivalents); a loader guard; `fixtures/api-contract-conformance/` or a filter-allowlist conformance fixture.
- [ ] Define the canonical op band per subtype once: `uuid` → string-class (`eq/ne/in/isNull`); `currency` → numeric ops; confirm enum/object/date/time/boolean. Apply IDENTICALLY in all 5 ports (codegen allowlist + load-validation). Add a loader guard: `@filterable: true` on a subtype with no op band → error (kills TS's silent empty-ops). Add a filter-allowlist conformance fixture covering currency/enum/uuid so the divergence can't recur. All 5 ports green.
- [ ] Review + simplify gate. Commit `feat(metadata): SP-H Unit9 — cross-port filter-op reconciliation (uuid/currency) + filterable-without-ops guard + fixture`.

### Unit 10: Coverage holes (metamodel + Kotlin corpus + boolean/object/date/time)
- [x] **DONE.** Added the `field-date-time-basic` metamodel fixture (`field.date` + `field.time` on one entity) to `fixtures/conformance/`; all four metamodel runners (TS / C# / Java / Python) discover + pass it (TS 304→306, Java 306, C# 558, Python green). **`field.boolean` + a typed `field.object` are already covered by the Unit 3 `AllTypes` op:roundtrip persistence scenario** (`bVal`, `settings` jsonb) — no new persistence work. **Kotlin metamodel corpus: DOCUMENTED, not wired (the principled answer).** Kotlin has no distinct loader/parser/serializer — `metadata-ktx`'s `Loader.kt` forwards directly to the Java `metadata` module's `MetaDataLoader`, which Java already runs the full corpus against (`ConformanceTest`); a parallel Kotlin run would re-invoke identical bytecode for zero added coverage. Kotlin's distinct surfaces (codegen/runtime) are gated by render/persistence/api-contract corpora, and its emitted vocabulary is byte-gated by `registry-conformance`. Documented in `fixtures/conformance/README.md`. Commit `feat(conformance): SP-H Unit10 — add field.date/field.time metamodel fixtures + resolve Kotlin metamodel-corpus coverage`.

## Phase 4 — Matrix gate + finish

### Unit 11: Per-subtype conformance matrix + finish
- [ ] Confirm every concrete subtype is exercised by metamodel + persistence-WRITE-roundtrip + codegen conformance in all 5 ports (close the audit matrix). Add a coverage assertion/report if helpful (extend `coverage-report.json` to flag a subtype lacking a persistence-roundtrip). Update CLAUDE.md + the divergence/coverage docs. Final simplifier + reviewer over the whole SP-H diff (focus: no subtype stubbed; writes gated cross-port; filter-ops identical; no codegen throws on legal metadata). Merge forward (integrate-before-merge).

## Self-review notes
- **Unit 3 is the keystone** — the WRITE round-trip corpus must land before the per-port codec units (4–8), which it gates. Without it, write-path fixes are unverifiable (the exact gap that hid byte/short).
- **The corpus is the spec** — each port unit's acceptance is its persistence-roundtrip + filter-allowlist conformance green; "study the existing port runtime/runner + match the shared fixtures."
- **ADR-0013 governs bare `field.object`** — error at load (Unit 2), don't stub/jsonb-default; downstream throws stay as defense-in-depth.
- **Cuts (field.class) mirror the byte/short cut** — verify zero consumers, regenerate the canonical, keep all registry gates green.
- **Coordinate with concurrent sessions** — this is metadata + persistence + per-port codec work; the sibling TPH codegen session is on the TS codegen entity/zod stack — watch for overlap in TS column/type mappers (Unit 4) + integrate-before-merge.
