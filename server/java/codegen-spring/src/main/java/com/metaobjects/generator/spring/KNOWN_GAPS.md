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

## Payload `origin.*` resolution not honoured (FR-006, Day-1)

**Status:** intentional Day-1 simplification.

`SpringPayloadGenerator` emits a `<TemplateShortName>Payload` Java record
with components mirroring the `@payloadRef` value-object's scalar fields,
using `SpringTypeMapper.javaTypeName` for type resolution. `origin.*`
children on payload fields (passthrough / aggregate / collection) are
NOT yet honoured — each field's type comes from its own subtype, not
from the dotted source it references.

The cross-port reference (Kotlin's `KotlinPayloadGenerator`) resolves
these:
- `origin.passthrough @from "Entity.field"` → source field's type
- `origin.aggregate @agg count` → `Long`; `@agg avg` → `Double`;
  `sum/min/max` → source `@of` field's type
- `origin.collection @via "Parent.rel"` → `List<TargetPayload>` (recurses
  into a nested payload class)

**Why deferred:** the cross-port `template-output-simple` and
`template-output-and-prompt` corpus fixtures both use plain VO field
projection (no origins), so payload codegen is honest at the
straightforward fixture level. Origin support is tracked here as a
follow-up so a future entity-projection consumer who needs it has a
clear known-gap rather than a silent type mismatch.

**Workaround:** consumers needing typed origin-driven payloads today can
hand-edit the generated record's field types. The `GENERATED` banner is
advisory — regeneration overwrites, so the hand-edit needs to be
preserved out-of-band until origin resolution lands.

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
