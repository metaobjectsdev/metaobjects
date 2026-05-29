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

## Decision: an invariant plus a configurable shape policy

Two separable concerns — do **not** conflate them (the earlier draft did):

### 1. Instance/write suppression — unconditional invariant (the bug fix)

An abstract metaobject must **never** emit instance or write artifacts, in any port,
under any configuration: no CRUD routes/controllers, repositories, write DTOs,
EF/Exposed tables, filter allowlists, validator-registry entries, stored-proc wrappers,
or `CREATE TABLE` DDL. These reference a table or export the abstract type never gets —
the output does not compile, or the migration materializes a phantom table. This is not
a preference and is not configurable.

| Port | Instance/write generators to guard (always skip abstract) |
|---|---|
| **TS** | — already done in `39f2df9f` |
| **C#** | `DbContextGenerator` (`DbSet<>`), `RoutesGenerator`, `FilterAllowlistGenerator`, `ExpectedSchema` (DDL); `EntityGenerator`'s `[Table]`/EF mapping |
| **Java/Spring** | `SpringControllerGenerator`, `SpringRepositoryGenerator`, `SpringFilterAllowlistGenerator`; the write portion of `SpringDtoGenerator` |
| **Kotlin** | `ExposedTableGenerator`, `RelationsGenerator`, `SpringControllerGenerator`, `StoredProcGenerator`, `ValidatorGenerator` |
| **Python** | `router_generator`, `filter_allowlist_generator`, `expected_schema` (DDL) |

### 2. Abstract-shape emission — a codegen-config knob

Whether an abstract metaobject emits a **shape** artifact (an abstract class, an
interface, a base model, a type-only interface) is a legitimate, situational choice —
sometimes you want an abstract base class so other generated or hand-written code can
reference the shared shape, sometimes you don't. It is therefore a **codegen
configuration option**, not a hardcoded rule and not a per-entity metadata attribute
(the metadata only declares *that* a type is abstract; how to render its shape for a
given target is a codegen concern).

Working name: `emitAbstractShapes` (final name per port). It maps onto each port's
**existing** codegen-config mechanism — verified against the actual config surfaces:

| Port | Config surface for the knob | How a generator reads it |
|---|---|---|
| **TS** | field on `MetaobjectsGenConfig` (`metaobjects.config.ts`), default-normalized in `normalizeConfig()`, threaded via `renderContext` | `ctx.renderContext.emitAbstractShapes` |
| **C#** | field on the `GenConfig` record (`MetaObjects.Codegen/Generator.cs`), set by a `meta` CLI flag (`--emit-abstract-shapes`) | `ctx.Config.EmitAbstractShapes` |
| **Java/Spring & Kotlin** | a **generator arg** in the Maven plugin — settable run-wide in `<globals>` or per-generator in `<generator><args>` (per-generator overrides global), the same `Map<String,String>` model as the existing template/filter/package/output args | `getArg("emitAbstractShapes", "false")` in the generator's `parseArgs()` (`GeneratorBase`) |
| **Python** | field on the `GenConfig` dataclass (`codegen/config.py`), set by the CLI | `ctx.config.emit_abstract_shapes` |

The Java/Kotlin model matters: the Maven plugin (`AbstractMetaDataMojo`) already wires
generators by classname and passes `<globals>` + per-`<generator><args>` (merged in
`mergeAndOverwriteArgs`) plus `<filters>`. The knob is one more arg in that map — no new
Mojo `@Parameter`, no `LoaderParam` change (it is a generation-policy concern, not a
loader concern). A consumer can set it once in `<globals>` to apply to every generator,
or per-generator to vary it.

**When the knob is ON, the shape is a *standalone* abstract class/interface** — concrete
subtypes still flatten all inherited fields inline and do **not** reference it yet.
Rewiring concretes to language inheritance (emit own fields only, `extends` the base) is
a **deferred follow-up** (see "Deferred"), because it rewrites every concrete entity
generator's field-walking and type declaration per port. This matches the
"configurable per port, decide later" decision.

### Per-port defaults (preserve sane behavior; confirm in review)

| Port | Default | Rationale |
|---|---|---|
| **TS** | **on** | already emits a type-only interface unconditionally; the knob just makes that explicit and toggleable |
| **C#** | **off** | concretes flatten; a standalone abstract class would be unreferenced dead code until the inheritance follow-up lands. Opt in to emit `public abstract class <Name>` |
| **Java/Spring** | **off** | same; opt in emits an abstract base (an `interface`, since records cannot serve as a base) |
| **Kotlin** | **off** | same; opt in emits an `abstract class` / interface |
| **Python** | **on (effectively pinned)** | Python concretes **already** subclass the base (`class Premium(Product):`) and import it — suppressing the abstract base model breaks every concrete's compile. So `entity_model` must keep emitting the abstract base whenever a concrete extends it. Python is thus already in the deferred "inheritance-on" state; this fix preserves it. |

This is the one place the per-port flatten-vs-inherit finding still bites: Python's
default differs because its generated concretes already depend on the base. The flatten
ports default off and are opt-in.

### The shared guard, per port

Mirror TS's `instance-artifacts` module idiomatically rather than re-deriving the rule
ad hoc per generator. The guard distinguishes the **invariant** (instance/write — always
skip abstract) from the **shape policy** (consult the config knob):

- **C#** — new `InstanceArtifacts` static helper in `MetaObjects.Codegen`
  (`IsAbstract` / `EmitsInstanceArtifacts` / `EmitsWriteArtifacts`), composed into each
  instance/write generator's `Filter` / iteration `Where`; the entity-shape path consults
  the config knob.
- **Java/Spring** — a single correct accessor reading `MetaData.ATTR_IS_ABSTRACT`
  (see "Java attribute-name unification"). Instance/write generators add
  `if (isAbstract(entity)) continue;`; the DTO/shape path branches on the config knob.
- **Kotlin** — lift `KotlinEntityGenerator`'s existing (working) check to a shared
  `KotlinGenUtil` helper; the five instance/write generators call it; the entity-shape
  generator consults the config knob.
- **Python** — new `instance_artifacts.py` (`is_abstract` / `emits_instance_artifacts`)
  mirroring TS; the instance/write generators short-circuit on it. `entity_model`
  consults the config knob (default on) and keeps emitting the abstract base.

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
