# Honor `abstract` universally across the non-TS codegen ports

_Design — 2026-05-29_

## Problem

An abstract metadata entity (`abstract: true`) contributes shape via inheritance
**only**. It has no instantiable representation, so codegen must never emit
instance/write artifacts for it — no CRUD routes, repositories, write DTOs, EF/Exposed
tables, filter allowlists, validator-registry entries, stored-proc wrappers, or
`CREATE TABLE` DDL. Emitting any of these produces output that references a table or
export the abstract type never gets: code that will not compile, or a migration that
materializes a phantom table.

The TypeScript port fixed this in commit `39f2df9f` ("honor isAbstract universally")
via a shared `instance-artifacts` guard composed into each generator's filter. The
**four other codegen ports were never audited** and almost universally do **not**
honor the flag.

### Audit result (current state)

| Port | Honors `abstract` | Generators that blindly emit instance/write artifacts for abstract entities |
|---|---|---|
| **TS** | ✅ all (fixed in `39f2df9f`) | — |
| **C#** | ❌ 0 of 5 | `EntityGenerator` (`[Table]` class), `DbContextGenerator` (`DbSet<>`), `RoutesGenerator` (CRUD), `FilterAllowlistGenerator`, `ExpectedSchema` (**CREATE TABLE DDL**) |
| **Java/Spring** | ❌ 0 of 4 entity generators | `SpringControllerGenerator`, `SpringDtoGenerator`, `SpringRepositoryGenerator`, `SpringFilterAllowlistGenerator` |
| **Kotlin** | ⚠️ 1 of 6 (only `KotlinEntityGenerator`) | `ExposedTableGenerator`, `RelationsGenerator`, `SpringControllerGenerator`, `StoredProcGenerator`, `ValidatorGenerator` |
| **Python** | ❌ 0 of 5 | `router_generator`, `filter_allowlist_generator`, `expected_schema` (**CREATE TABLE DDL**); `entity_model` emits the abstract model (which is **correct** for Python — see below) |

Template-driven generators (output parsers, payload VOs, prompt fragments) iterate
`template.*`, not entities, and are out of scope: they are not entity instance
artifacts.

## The deciding finding: flatten vs. inherit

The metamodel resolves `extends` at load time, but the **canonical serialized form does
not flatten** — a concrete `Premium extends Product` keeps only its own children. So
each port's codegen must do *something* to surface inherited fields. What it does splits
the ports into two camps and **decides what an abstract entity should emit**:

| Port | Generated concrete-entity code | References the base type? |
|---|---|---|
| **TS** | flattens all inherited fields inline (`entity.fields()`); no `extends`/intersection | ❌ no — the abstract interface it emits is unreferenced |
| **C#** | flattens (`entity.Fields()` includes inherited; class has no `: Base`) | ❌ no |
| **Java/Spring** | flattens (`getMetaFields()` includes inherited; records cannot extend) | ❌ no |
| **Kotlin** | flattens (`obj.metaFields` includes inherited; no `superclass()`) | ❌ no |
| **Python** | **inherits** (`class Premium(Product):`, imports the base, emits own fields only) | ✅ **yes** |

**Python is the sole exception.** Its concrete Pydantic models subclass the base and
import it, so suppressing the abstract base's model would break every concrete
subtype's import/compile. The four flatten ports have the opposite property: concrete
output is fully self-contained, so the abstract base's shape artifact is dead weight
nothing points at.

## Decision: per-port emit behavior

| Port | Abstract entity emits | Generators to guard (skip abstract) |
|---|---|---|
| **TS** | type-only interface (already) | — already correct, no change |
| **C#** | **nothing** | `EntityGenerator`, `DbContextGenerator`, `RoutesGenerator`, `FilterAllowlistGenerator`, `ExpectedSchema` |
| **Java/Spring** | **nothing** | `SpringControllerGenerator`, `SpringDtoGenerator`, `SpringRepositoryGenerator`, `SpringFilterAllowlistGenerator` |
| **Kotlin** | **nothing** | `ExposedTableGenerator`, `RelationsGenerator`, `SpringControllerGenerator`, `StoredProcGenerator`, `ValidatorGenerator` (`KotlinEntityGenerator` already correct) |
| **Python** | **the Pydantic base model only** | `router_generator`, `filter_allowlist_generator`, `expected_schema` — **`entity_model` keeps emitting** the abstract base (concretes `extends` it) |

Adding a *new* type-only convenience artifact to the flatten ports (to mimic TS's
interface) is **out of scope**: it is net-new emission rather than a bugfix, and nothing
in the generated output would reference it.

### The shared guard, per port

Mirror TS's `instance-artifacts` module idiomatically rather than re-deriving the rule
ad hoc in each generator:

- **C#** — new `InstanceArtifacts` static helper in `MetaObjects.Codegen`
  (`IsAbstract` / `EmitsInstanceArtifacts` / `EmitsWriteArtifacts`), composed into each
  generator's `Filter` / iteration `Where`.
- **Java/Spring** — a single correct accessor reading `MetaData.ATTR_IS_ABSTRACT`
  (see "Java attribute-name unification" below). Each generator's `execute()` loop adds
  an `if (isAbstract(entity)) continue;` guard.
- **Kotlin** — lift `KotlinEntityGenerator`'s existing (working) check to a shared
  `KotlinGenUtil` helper; the other five generators call it.
- **Python** — new `instance_artifacts.py` (`is_abstract` / `emits_instance_artifacts`)
  mirroring TS; the instance/write generators short-circuit on it. `entity_model` does
  **not** use the guard — it must keep emitting the abstract base.

## Java attribute-name unification (`_isAbstract` → `isAbstract`)

The Java tree carries two abstract-attribute names. The canonical pipeline already uses
**`isAbstract`** consistently:

- `MetaData.ATTR_IS_ABSTRACT = "isAbstract"` — the registered universal attribute.
- The canonical JSON parser stores `abstract: true` as a MetaAttribute named
  `isAbstract` (`CanonicalJsonParser` line 694).
- The serializer, `ValidationPhase`, and Kotlin's working `EntityGenerator` all read
  `isAbstract`.

`_isAbstract` is vestigial and lives in three places, all to be removed/fixed:

1. `BaseMetaDataParser.ATTR_ISABSTRACT = "_isAbstract"` + its `reservedAttributes.add(...)`
   — a legacy reserved-attr registration never used to set the flag. **Remove.**
2. `IOUtil.isAbstract()` and `GeneratorUtil.isAbstract()` — both check `_isAbstract` and
   therefore return `false` for every canonically-loaded entity (the latent dead
   accessor). **Fix to read `MetaData.ATTR_IS_ABSTRACT`.**
3. Stale comments in `CanonicalJsonParser` (lines 63/96/690) claiming the flag is stored
   as `_isAbstract`. **Correct to `isAbstract`.**

Nothing *writes* a `_isAbstract` attribute, so no canonical data depends on it. The
deletion is gated behind the full Java + conformance suite; if a legacy-XML fixture
trips on it (e.g. `test-interface-metadata.json`), surface it rather than silently
retaining `_isAbstract`.

Out of scope: Java stores the flag as a MetaAttribute child while TS/Python/C# use a
first-class boolean field. That representational divergence round-trips correctly through
the serializer and is not addressed here.

## Testing

**Per-port unit tests now** — mirror TS's `abstract-skip` / `instance-artifacts` tests.
For each port, a fixture with an abstract base + a concrete subtype, asserting:

- the abstract entity produces **no** instance/write artifact (no route/controller, no
  repository, no table/Exposed object/EF class, no filter allowlist, no validator-registry
  entry, no stored-proc, no `CREATE TABLE` DDL);
- the concrete subtype still produces its full set of artifacts with all inherited fields;
- **Python additionally**: `entity_model` still emits the abstract base model, and the
  concrete model `extends` it (`class Concrete(Base):` + import).
- **Java additionally**: a test loading `abstract: true` canonical JSON asserts the
  stored MetaAttribute is named `isAbstract`, and `GeneratorUtil.isAbstract()` /
  `IOUtil.isAbstract()` return `true` for it.

**Cross-port codegen-output conformance corpus — follow-up (separate work).** A shared
`fixtures/codegen-conformance/` corpus that every port's codegen runs against would catch
the whole class of codegen-divergence bugs (not just abstract), but it is a substantial
new harness in five ports. Filed as follow-up, not part of this fix. (The existing
`fixtures/conformance/` corpus tests only the loader + canonical serializer + error
envelopes — it cannot cover generated-code output.)

## Sequencing

Four independent ports, plus the Java accessor unification. One port per unit, TDD
red→green, then the **review + simplify gate before merging each unit forward** (the
established pre-merge rule). Order:

1. **C#** — 5 generators incl. DDL; establishes the `InstanceArtifacts` helper pattern.
2. **Java/Spring** — 4 generators **+ the `_isAbstract` → `isAbstract` unification**
   (fixes `GeneratorUtil`/`IOUtil`, removes the legacy constant, corrects comments).
3. **Kotlin** — 5 generators; reuses the now-correct shared check.
4. **Python** — the special case: guard router/allowlist/DDL, keep `entity_model`.

Each unit merges forward to `main` only after its review + simplify gate passes and the
relevant suite is green. Work happens in the `abstract-codegen-ports` worktree.

## Out of scope

- Loader-level placement validation (whether concrete field/view is allowed at the root
  package level). That is a separate, deeper design question and is **not** this bug.
- A new type-only shape artifact in the flatten ports.
- Unifying Java's MetaAttribute-based abstract storage with the other ports' boolean field.
- The cross-port codegen-output conformance corpus (filed as follow-up).
