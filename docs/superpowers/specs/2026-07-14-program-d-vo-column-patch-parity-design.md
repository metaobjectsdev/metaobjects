# Program D — cross-port value-object jsonb-column PATCH parity (Java / Kotlin / C#)

**Date:** 2026-07-14
**Status:** Planned. Execution deferred to a FRESH session (this doc is the self-contained brief). Design reviewed by a Fable subagent (2026-07-14) which found + corrected a load-bearing flaw and several scope errors — the corrections are baked in below.
**Context:** FR-036 (`0.16.0`/`7.8.0`, shipped) DEFERRED "Program D": object/value-typed jsonb columns are non-PATCH-able on Java/Kotlin/C# by a **deliberate Day-1 simplification** (Java/Kotlin exclude `ObjectField` from the patch set; C# skips the EF owned-nav via a `FindProperty`-miss). TS + Python already PATCH VO columns (verified: TS `UpdateSchema` embeds `<Ref>InsertSchema`; Python `<Name>Patch` types VO fields as the VO model). This closes the gap for **value objects (single + `@isArray`)** so a C#/Java/Kotlin single-port fix can't break the api-contract byte-identical parity.

**Owner rulings (2026-07-14):**
1. **Full nested VO validation on PATCH** (byte-identical with TS's `z.array(<Ref>InsertSchema)`), not bind+write-only.
2. **Scope = value-object columns only** (`field.object @storage:jsonb`, single AND `@isArray`). `field.map` and the Kotlin `field.string @dbColumnType:jsonb` open-bag are **STAGED OUT** to tracked follow-ups (see §6).

---

## 0. The load-bearing correction (Fable, empirically proven — do NOT re-derive)

`jakarta.validation.Validator.validateValue(BeanClass, propertyName, value)` **does NOT cascade `@Valid`** into a nested VO's constraints — this is Jakarta Bean-Validation spec behavior (`validateProperty`/`validateValue` never cascade), proven by compiling + running against the repo's `hibernate-validator-8.0.1.Final`: `validateValue(single VO, @Valid)=0` and `validateValue(List<VO>, @Valid)=0`, while `validate(bean)=2` and `validate(vo)=1`. **The FR-036 vanilla + TPH PATCH paths are built on `validateValue`** (Java `SpringControllerGenerator.java:316,568,595`; Kotlin `KotlinSpringControllerGenerator.kt:440,444,838,842`).

**Correct mechanism:** keep `validateValue(Bean.class, prop, value)` for the property's OWN constraints (`@NotNull`, `validator.array` `@Size` — those DO fire), and ADD explicit `validator.validate(voInstance)` per present VO value (iterate for `List<VO>`). For VO-nested-in-VO (depth ≥ 2), `validate(vo)` only cascades through `@Valid` on the VO class's own members, so emit `@Valid` on nested-VO members of the generated JVM VO classes (or recurse explicitly). C#: per-element `Validator.TryValidateObject(vo, …, validateAllProperties: true)` + manual recursion into nested VO members (`TryValidateObject` is non-recursive).

---

## 1. Parity baseline (verified — the goal is correctly scoped, not over-built)

- **TS: validates nested VO on PATCH.** `UpdateSchema` embeds `<Ref>InsertSchema` (`zod-validators.ts:396-422`) with `.optional()`+`.nullable()` for non-required (`:322-336`); routes bind `updateSchema` (`routes-file.ts:173,197`).
- **Python: validates nested VO on PATCH.** `<Name>Patch` types VO fields as the VO Pydantic model (`entity_model.py:482-507`, import `:212-220`); router runs `<Name>Patch(**dto)` (`router_generator.py:341`); Pydantic recurses.
- **Caveat to pin (Python):** the VO read model keys by `@column` when present (`entity_model.py:266`) — a VO member with a snake_case `@column` validates under the column name, not the wire name. Add a wire-name pin for the VO validation model.
- **Nothing gates VO PATCH over HTTP today** — the new scenarios are first-exercise for ALL 5 ports, both lanes; they may flush latent TS/Python bugs. Budget for it.

---

## 2. Per-port work (each is a DIFFERENT size — verify each file:line)

### Java (`codegen-spring`) — the BIGGEST; a new VO layer
`codegen-spring` generates NOTHING for `object.value` today (`SpringDtoGenerator.execute()` filters entity/projection `:88-89`; class javadoc `:44-48` defers the `field.object` arm). Required:
1. **New VO-record emitter**: a Java record per `object.value` with jakarta constraints on its members (reuse `validationAnnotations` `:572-655`) + `@Valid` on nested-VO members.
2. `SpringDtoGenerator`: stop excluding `ObjectField` from `settableFields`/`scalarFields` (`:443` only filters `ObjectField` for scalars; `:291-304`); add object component-type arms to the `<Entity>Dto` + `<Entity>Patch` (bind via Jackson `treeToValue` to the VO record / `List<VO>`). VO-inside-VO enum qualification: `patchComponentType` (`:311-316`) doesn't reach into VO records — handle.
3. **Controller PATCH**: `validateValue(<Dto>.class, field, value)` (own constraints) + explicit `validator.validate(voElement)` per element (§0). Also POST — Java's create already runs `validator.validate(dto)`; ensure `@Valid` cascade there is likewise replaced by explicit per-element `validate` OR rely on the fact that `validate(dto)` DOES cascade `@Valid` on `dto`'s VO field (validate(bean) cascades; only validateValue doesn't — so POST may already work if the DTO's VO field carries `@Valid`; VERIFY).
4. Repo seam is DTO-typed (`SpringRepositoryGenerator.java:123`) — the DTO must carry the VO field so GET returns it + `patch` writes the jsonb column.

### Kotlin (`codegen-kotlin`) — read + create + patch (not PATCH-only)
The entity data class + Exposed table are already VO-capable (#187 Jackson `MetaJsonbMapper`). But the CONTROLLER skips VO in `rowToEntity` (`KotlinSpringControllerGenerator.kt:302-305`, read) and the create insert loop (`:375-387`) — PATCH-only would make write-only columns invisible in every response → read-back scenarios fail. Required: include VO in read + create + patch; stop excluding `ObjectField` from `patchSettableFields`; bind via `MetaJsonbMapper`; validate = `validateValue` (own) + explicit `validate(voElement)` per element (Kotlin VO data classes already carry constraints — `KotlinEntityGenerator.kt:152-158,494-498`; add `@field:Valid` on nested-VO members). allWarningsAsErrors-clean.

### C# (`codegen`) — merge-loop arms + VO attributes + POST + metadata-required
Entity class, create-bind, and read already work. Required:
1. **Merge loop**: when `FindProperty` misses (`RoutesGenerator.cs:AppendPartialMergeLoop`, the `if (target is null) continue;`), emit **typed per-field arms** (codegen knows the VO fields) that deserialize the JSON to the VO type and assign the **CLR property** on the tracked entity (`existing.<Nav> = <deserialized VO / List<VO>>`) — NOT `entry.Navigation(...).CurrentValue` (unverified; wrong pattern). EF Core 8 `.OwnsOne/.OwnsMany(...).ToJson` persists via `DetectChanges` full-document replacement.
2. **VO validation attributes**: the VO POCOs are emitted attribute-free (`EntityGenerator.cs:596`, `:759-761`). Split validation-attr emission from EF-mapping attrs (the `withAttributes` flag) so VO POCOs carry `[Required]`/`[StringLength]`/etc.
3. **Nested validation on BOTH PATCH and POST**: `TryValidateObject(..., validateAllProperties: true)` is non-recursive — recurse per VO element into nested members. C# doesn't validate nested VO on CREATE either → cover POST in the same scenario.
4. **Metadata-driven required-null 400**: the present-null-on-`@required` check keys off `target.IsNullable` (`RoutesGenerator.cs:513`) — but EF models an owned-nav nullable even when `@required` (`DbContextGenerator.cs:365-369`), so a present-null on a `@required` VO column would 500 (NOT NULL) instead of 400. Emit the required-ness from **metadata at codegen**, never EF model metadata.

---

## 3. The FR-035 tristate for VO columns
Present `[]` vs present-`null` vs absent is unambiguous in Jackson/STJ/Zod/Pydantic — no empty-array-as-null coercion trap. Semantics (identical to scalars): absent→untouched; present-`null`→clears a nullable column / **400 on `@required`** (via the metadata-driven check, §2 C#-4); present-`[]`→writes empty array (not null); present-value→validate+write. C# non-required VO array null-vs-`[]` is deliberately distinct (nullable collection, no initializer — `EntityGenerator.cs:1016-1026`); don't "fix" it. **TS open-bag caveat** (`z.unknown()` accepts null, `zod-validators.ts:390-394`) — irrelevant here since the open bag is staged out, but keep any open-bag gate column non-required.

---

## 4. Gate — extend `fixtures/api-contract-conformance/jsonb/` (Fable-confirmed lower-churn)
The `row` assertion is a per-key **subset** match (`ApiContractAssertions.kt:79-87`) so adding NULLABLE VO columns to `Document` leaves `jsonb-open-bag-roundtrip.yaml` green. All 10 lane surfaces are pre-wired (TS/C#/Java/Kotlin/Python each have a jsonb reference server + generated harness; the Kotlin jsonb lane already runs Testcontainers PG). Add to `Document`: a nullable single-VO column + a nullable array-of-VO column (reuse a `Label`-style `object.value`), and one `@required` VO variant IF the C# metadata-required fix (§2 C#-4) is in scope. New scenarios (both lanes, all 5 ports; the C# generated lane is full-stack vs Testcontainers PG so **every scenario re-reads via GET** to convict persistence):
- present-value valid → 200 + persisted re-read.
- present-value nested-constraint violation → 400 (**cover POST too** — flushes C#'s CREATE gap).
- present-null → clear (non-required); present-`[]` → empty array persists; absent → untouched.
- (if in scope) present-null on `@required` VO → 400.

Each port's jsonb reference server gets matching handling (mechanical column additions + seed).

**Persistence proof already exists** for VO single+array: `roundtrip-all-types.yaml` (`settings` single-VO + `labels` array-of-VO). No new persistence-conformance column needed for the VO scope (only `field.map` would need one — staged out).

---

## 5. Sequencing
1. Gate first (RED): extend the `jsonb/Document` fixture + scenarios; confirm RED on Java/Kotlin/C# generated + reference lanes, GREEN on TS/Python (fix any latent TS/Python bug found).
2. C# (smallest): merge-loop typed arms + VO attributes + POST nested validation + metadata-required.
3. Java (biggest): VO-record emitter → DTO/Patch arms → controller validate → repo seam.
4. Kotlin: read+create+patch inclusion + validate.
5. Fork-per-port (the FR-036 pattern); code-review + simplify per unit; independently re-run each port's gate (don't trust a fork's green).

## 6. Explicitly STAGED OUT (tracked follow-ups, NOT in this program)
- **`field.map @objectRef`** (dict-of-VO jsonb): no fixture exists anywhere (never proven to persist), C# has no EF mapping for `Dictionary<string,VO>` (`EntityGenerator.cs:1042-1048`, no `DbContextGenerator` map arm → EF finalization rejects), and it would hit the Java DTO generator's unsupported-type throw today (`SpringTypeMapper.javaTypeName` has no map arm). **Sequence: a persistence-conformance `field.map` roundtrip column FIRST (SP-H), then the HTTP tier.**
- **Kotlin `field.string @dbColumnType:jsonb` open-bag PATCH**: #187's `MetaJsonbMapper` covers object/map ONLY; the open bag still decodes to kotlinx `JsonElement` (`KotlinExposedTableGenerator.kt:334-350`, `KotlinTypeMapper.kt:313-314`), which Jackson `treeToValue` can't produce (`codegen-kotlin/.../KNOWN_GAPS.md:75-83` still stands). Solvable via a `kotlinx.serialization.json.Json.parseToJsonElement(node.toString())` bridge (the "#179 guard" is import-hygiene, not a hard blocker) — but a distinct mechanism. Java's open-bag is already PATCH-able (typed `Object`), C#'s is an EF scalar property; **Kotlin is the only laggard**, and the all-ports corpus discipline means the open-bag PATCH *scenario* can't land until Kotlin is fixed.
- **TPH entities with VO columns**: Java/Kotlin TPH unions skip `ObjectField` (`SpringDtoGenerator.java:327`). Out of scope.

## 7. Discipline (FR-036 lessons — every one burned someone)
Two-lane real-boot gates, not goldens alone; a golden may ENCODE the bug (verify before regenerating); each new shared wire-tier scenario needs the hand-rolled REFERENCE servers taught the same handling (they lag the generated lane); run an xhigh code-review BEFORE release (FR-036's caught 11 cross-port divergences the corpus missed); JVM generated code compiles under `allWarningsAsErrors`; PG-testcontainer readiness flakes under load (re-run); PUBLIC repo hygiene (no home paths / private names). Study the reference implementation (TS/Python) for the exact nested-validation semantics; don't re-derive.
