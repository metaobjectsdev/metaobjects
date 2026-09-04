# `metaobjects-codegen-spring` — known gaps

This document tracks deliberate Day-1 deferrals in the Spring codegen target.

## Single-field, `Long`-typed primary keys only

**Status:** assumption baked into Day 1.

The generated controller assumes the entity's primary key is a single
field of type `Long` (the canonical `BaseEntity` convention across the
shared corpus). Composite primary keys would require a URL grammar for
composite ids (`/api/<entity>/{idA}_{idB}` or similar) that the
cross-port contract has not yet specified. Entities with non-`Long`
single-field PKs (e.g. `UUID`) will still generate, but the
`@PathVariable Long id` typing in the generated code will need a
hand-edit until typed-PK threading lands in the generator.

**Why deferred:** non-`Long` PKs are uncommon and composite PKs are
rarer still. Adding generic PK-type threading to the generator is a
non-trivial spec change that should be discussed at the cross-port
contract level first.

## DTO equals `<Entity>` (no separate `<Entity>Insert` / `<Entity>Update`)

**Status:** intentional Day-1 simplification.

The generated controller uses a single `<Entity>Dto` record for both
request and response bodies (and for `POST`, `PATCH`, and `PUT`). This
differs from the TS reference implementation, which emits separate
`<Entity>Insert` and `<Entity>Update` shapes (Update is partial). The
cross-port contract's wire shape is the same in either direction (no
envelope on single-row responses; the body is the row), so the
single-record approach interoperates correctly with the TS client.

**Why deferred:** Java records are not naturally partial — every field
is required at construction. A real `<Entity>Update` partial record
needs either `Optional<T>` arms (verbose) or a builder + nullable
representation, neither of which is a one-liner. A follow-up can add
these once the partial-update story is settled cross-port.

**Write-through interaction (FR-024 §7, #214).** A write-through entity
read-view carries DERIVED (`origin.*`) fields on its read shape. The
`<Entity>Patch` (update input) EXCLUDES all derived fields
(`SpringDtoGenerator.minusPk` drops `field.isDerived()`), the read `<Entity>Dto`
carries them, and — because Java shares one `<Entity>Dto` for read AND create —
a derived field on a write-through entity carries NO client-validation constraints
(`validationAnnotations` early-returns for it, like an `@autoSet` field), so a `POST`-create
that omits the view-computed field is not wrongly `400`'d. The single residual facet:
that same shared-DTO decision means a guaranteed-non-null `origin.aggregate @agg:any|all|collect`
field loses its read-side `@NotNull` (its value is still returned, just annotated nullable) —
a projection keeps it (read-only, no create path). Restoring the read-side non-null annotation
without re-breaking create needs the derived-free `<Entity>Insert` split folded in above.

## Output parser is throw-only (no try-style variant)

**Status:** by design, per ADR-0010 §3.

`SpringOutputParserGenerator` emits a single `parse(String text)` method
that throws `JsonProcessingException` on bad input — matching Jackson's
convention. Consumers wrap with their own try/catch when they need
explicit error handling (Spring's `@ControllerAdvice` chain is the
idiomatic place).

This differs from the TS port (dual API matching Zod/AI SDK), C#
(`Parse`/`TryParse` matching BCL), and Kotlin (`parse`/`safeParse`
Result-style). Python and Java are the two throw-only ports because
their host-language convention is throw-only at the JSON-parse boundary.

**Why this is here**: documenting the divergence so it's not mistaken
for a missing feature.

## Generated parser requires Jackson on the runtime classpath

**Status:** consumer-wiring contract.

The generated `<TemplateShortName>Parser` imports
`com.fasterxml.jackson.databind.ObjectMapper` and
`com.fasterxml.jackson.core.JsonProcessingException`. Consumers must
have Jackson available at runtime. Spring Boot's
`spring-boot-starter-web` brings Jackson automatically as a transitive
dependency, so the typical Spring consumer needs no explicit setup.

Non-Spring-Boot consumers (or those who exclude Jackson from
`spring-boot-starter-web` via `<exclusions>`) must add
`com.fasterxml.jackson.core:jackson-databind` explicitly.

## FR-010 tolerant `extractLenient()` — two overloads (Plan 2 + Plan 2.1)

For `template.output` nodes whose `@format` is `json` or `xml`,
`SpringOutputParserGenerator` emits two never-throwing, typed
`extractLenient(...)` flavours returning `ExtractionResult<<Payload>>`:

1. **Self-contained** `extractLenient(String[, ExtractOptions])` — driven by a
   codegen-baked `ExtractSchema` (`ExtractSchemaEmitter`) + `ExtractMap`
   reads. Maps **scalar, enum (incl. `@enumAlias` folding), and
   scalar-array** payload fields. Needs only `metaobjects-render` (+
   Jackson for `parse`). **Does NOT populate nested-object /
   array-of-object components** — those map to a typed `null` (a
   `/* FR-010: nested extract deferred — use extractLenient(loader, text) */`
   marker appears in the generated source). The `ExtractionReport` still
   classifies the field, so nothing is silently wrong.

2. **Runtime-delegating** `extractLenient(MetaDataLoader, String[, ExtractOptions])`
   (Plan 2.1) — resolves this payload's `MetaObject` by its baked
   `PAYLOAD_FQN` from the supplied loader and delegates to
   `com.metaobjects.object.extract.MetaObjectExtractor` (module
   `metaobjects-om`), which assembles the **full object graph** —
   nested objects, arrays-of-objects, enum coercion, generalized
   `@default` — reflection-free via the Phase A object model. The
   assembled `ValueObject` graph (a `Map<String,Object>`) is then mapped
   into the typed payload-record graph by generated `from<Payload>(Map)`
   helpers. **This closes the nested codegen gap.**

**Choosing an overload.** Use the self-contained form for a flat
scalar/enum payload with no `MetaDataLoader` on hand; use the
runtime-delegating form whenever the payload has nested objects or
arrays-of-objects (or whenever a loader is available — it is strictly
more capable).

**Runtime classpath.** The self-contained `extractLenient(String)` needs
`com.metaobjects:metaobjects-render` (+ Jackson for `parse`). The
runtime-delegating `extractLenient(MetaDataLoader, ...)` additionally needs
`com.metaobjects:metaobjects-om` (which transitively brings `render` +
`metadata`). This is the codegen-wrapping-runtime precedent (a generated
DAO depending on OMDB).

**Hardening TODO (minor):** `ExtractSchemaEmitter` emits string literals
(field names, enum values, alias keys/values) without Java-string
escaping. Field names and enum members are identifier-safe and alias
*values* are canonical members, so the only at-risk input is an
`@enumAlias` *key* containing a `"` or `\`. Add a `javaStringLiteral(...)`
escape if adopters hit it.

## FR-035 partial PATCH — present-value validation (RESOLVED by FR-036)

The generated `PATCH`/`PUT` handler binds a raw `JsonNode` and builds an
`<Entity>Patch` (presence-tracked) — this is what gives it the FR-035 tristate
(absent ≠ explicit null). **FR-036 wired present-value constraint validation on
top of it:** the handler injects a `jakarta.validation.Validator` and runs
`validateValue(<Entity>Dto.class, field, value)` on each PRESENT value (per-field,
never the whole bean — so an absent `@required` field is not a false 400) →
HTTP 400 `{"error":"validation"}`. This holds on both the vanilla and (FR-036
Program B) the TPH per-subtype update paths. (The prior note here — and the claim
that "TS/Python DO validate on PATCH" — was wrong: before FR-036 only TS's vanilla
path validated present values; the TPH path validated on no port. All ports now do.)

## Value-object jsonb columns are PATCHable (Program D — SHIPPED)

A `field.object` value-object column mapped to a jsonb column (single or
`@isArray`) is now bound → validated → written on `PATCH` and `POST`, cross-port
(TS / Python / Java / Kotlin / C#), gated by
`fixtures/api-contract-conformance/jsonb/scenarios/jsonb-value-object-patch.yaml`
in both lanes. `SpringDtoGenerator.settableFields` includes `ObjectField`; a new
`SpringValueObjectGenerator` emits the VO records the DTO/Patch bind. Nested VO
constraints validate in full (spec §0: `validateValue` does NOT cascade `@Valid`,
so the controller adds an explicit `validator.validate(voElement)` per present
element). FR-035 tristate holds for VO columns (absent → untouched; present-null
clears a nullable column / 400s a `@required` one; present-`[]` writes an empty
array, distinct from present-null → SQL NULL).

**Still staged out** (tracked follow-ups): `field.map` (dict-of-VO — needs a
persistence-conformance roundtrip column first) and the Kotlin `field.string
@dbColumnType=jsonb` open-bag PATCH (needs a kotlinx `parseToJsonElement` bridge).
TPH entities with VO columns also remain out of scope (the TPH union skips
`ObjectField`).

## `SpringPayloadGenerator.resolveObjectByShortOrFqn` has zero in-repo callers

**Status:** deliberately kept, not dead code — recorded here so it is not later
rediscovered as live.

#270 (payload typing is declared-type-authoritative) deleted the payload
generator's `origin.*` type-dispatch and dotted-ref navigation, which held the
last in-repo callers of the `protected static` `resolveObjectByShortOrFqn`
(and its private `shortName` support). The helper stays because `protected`
members of this deliberately-extensible generator are adopter subclass API —
removing one is an API break out of proportion to the cleanup. Same
keep-and-record policy as `KotlinGenUtil.splitDottedRef` in the sibling
`codegen-kotlin` module's `KNOWN_GAPS.md`. Prune in a future MAJOR. (The other
stranded origin helpers — `firstOriginChild`, `resolveDottedFieldRef`,
`splitDottedRef` — were deleted: the private ones are not adopter-facing, and
the `MetaOrigin` inspector had zero callers anywhere, the review's own
delete-unless-genuinely-used-elsewhere rule.)

## FR-015 stored-procedure callables are NOT generated by this port

**Contract.** FR-015 gives a `source.rdb @kind: storedProc` / `tableFunction` a generated
typed wrapper whose call arguments come from the `@parameterRef` value object's fields, in
declaration order.

**Today.** This port has NO callable generator. `@parameterRef` is read only by the loader
and its validation passes; nothing in this package emits a wrapper, so a proc-kind
projection generates its read-model DTO and no way to invoke the procedure.

**Where it DOES ship.** TypeScript (`codegen-ts` `callable-file.ts`), C#
(`MetaObjects.Codegen` `CallableGenerator`) and Kotlin (`codegen-kotlin`
`KotlinStoredProcGenerator`).

**Why this is recorded rather than fixed.** `AGENTS.md` claimed FR-015 shipped
"cross-port", which was not true and has been corrected in the same change that added this
entry — the false claim was the actual defect, and a documentation claim is fixed by
correcting it, not by building two generators to make it retroactively true. Building this
one is feature work, and it is additionally blocked: the originating plan left
`@exposeAsRoute` explicitly UNDECIDED, and that decision shapes the generated surface.

**Workaround.** Call the procedure by hand. The physical name is available from the
generated names artifact, so the call site need not respell it.

