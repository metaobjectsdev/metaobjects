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

## FR-010 tolerant `recover()` — two overloads (Plan 2 + Plan 2.1)

For `template.output` nodes whose `@format` is `json` or `xml`,
`SpringOutputParserGenerator` emits two never-throwing, typed
`recover(...)` flavours returning `RecoveryResult<<Payload>>`:

1. **Self-contained** `recover(String[, RecoverOptions])` — driven by a
   codegen-baked `RecoverSchema` (`RecoverSchemaEmitter`) + `RecoverMap`
   reads. Maps **scalar, enum (incl. `@enumAlias` folding), and
   scalar-array** payload fields. Needs only `metaobjects-render` (+
   Jackson for `parse`). **Does NOT populate nested-object /
   array-of-object components** — those map to a typed `null` (a
   `/* FR-010: nested recover deferred — use recover(loader, text) */`
   marker appears in the generated source). The `RecoveryReport` still
   classifies the field, so nothing is silently wrong.

2. **Runtime-delegating** `recover(MetaDataLoader, String[, RecoverOptions])`
   (Plan 2.1) — resolves this payload's `MetaObject` by its baked
   `PAYLOAD_FQN` from the supplied loader and delegates to
   `com.metaobjects.object.recover.MetaObjectRecover` (module
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

**Runtime classpath.** The self-contained `recover(String)` needs
`com.metaobjects:metaobjects-render` (+ Jackson for `parse`). The
runtime-delegating `recover(MetaDataLoader, ...)` additionally needs
`com.metaobjects:metaobjects-om` (which transitively brings `render` +
`metadata`). This is the codegen-wrapping-runtime precedent (a generated
DAO depending on OMDB).

**Hardening TODO (minor):** `RecoverSchemaEmitter` emits string literals
(field names, enum values, alias keys/values) without Java-string
escaping. Field names and enum members are identifier-safe and alias
*values* are canonical members, so the only at-risk input is an
`@enumAlias` *key* containing a `"` or `\`. Add a `javaStringLiteral(...)`
escape if adopters hit it.
