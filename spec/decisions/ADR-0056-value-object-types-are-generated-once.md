# ADR-0056: A value object's type is generated once — the template tier references it

## Status

**Accepted** (2026-09-21). Supersedes the payload-tier half of
[ADR-0044](ADR-0044-payload-record-naming-cross-package-collision.md) (collision-qualified
`<Short>Payload` names). Restores the FR-004 design intent ("the prompt payload is a projection
value-object — reuse, not new"). Fixes #387. **Breaking for generated output:** types move, and
the `payload` generator is removed from every port that had one.

## Context

A template names the shape it renders with `@payloadRef`, and a responding `template.prompt` names
the shape it parses with `@responseRef` (ADR-0052). Both point at an `object.value` (or a sourceless
`object.projection`, #210).

FR-004 designed this as reuse: *"the prompt payload is a projection value-object (reuse, not new) …
the projection codegen already emits the per-language VO class."* No port implemented it that way.
Each one grew a **second type family** for the same metadata, emitted by the template tier:

| Port | The value object's own type | The template tier's copy |
|---|---|---|
| TypeScript | `entityFile()` → `interface X` in `X.ts` | `promptRender()` re-declares `interface X` for every `object.value` in `prompts.ts`; the output parser adds `<T>Data` plus nested mirror interfaces |
| C# | `EntityGenerator` → `class X` (only when an entity reaches it) | `PayloadGenerator` → `sealed record X` in each root's `<Root>.payload.cs`, all under one namespace |
| Java | `SpringValueObjectGenerator` → `record X` in X's package (only when an entity jsonb column reaches it) | `SpringPayloadGenerator` → `<Template>Payload` and `<Short>Payload` in `<template-pkg>.prompts` |
| Kotlin | `KotlinEntityGenerator` → `data class X` in X's package, for every `object.value` | `KotlinPayloadGenerator` → `@Serializable <Template>Payload` / `<Short>Payload` / `<Template>Response` in `<template-pkg>.prompts` |
| Python | `entity_model` → `class X(BaseModel)` in `X.py` | `payload_vo_generator` → `<Template>Payload` and `<Short>Payload`, repeated in every template's module |

The second family is where the defects come from:

- **#387.** In Java and Kotlin, a nested value object shared by templates in two packages is
  written into whichever template's `prompts` package sorts first. It is then referenced by a bare
  name from the other package, where no such class exists, and the adopter's build fails with
  `cannot find symbol` in generated code.
- **ADR-0044.** Its collision-qualified names (`AcmeAlphaNotePayload`), its closure-scoped naming
  pass, and `ERR_PAYLOAD_NAME_COLLISION` exist only because the copies are written into the
  *template's* package. There, two value objects from different packages can share a short name.
  In the value object's own package they cannot, because its FQN is unique.
- **Drift between the copies.** Each family has its own field-type map, nullability rule and enum
  naming. For example, the TS payload interface bridged `| null` while the value-object interface
  did not. Every such difference is a place where "the same shape" disagrees with itself.

The fix the adopter proposed in #387 was to emit one copy per consuming package. That removes the
compile error by making the duplication worse: N non-interchangeable classes for one shape.

## Decision

1. **One type per value object, emitted by the value-object generator.** Each port's
   value-object generator emits exactly one type per concrete `object.value`, at that object's
   canonical location (its declaring package or module). It also does this for every concrete
   sourceless `object.projection`, which is pure shape in the same sense. The generators are
   TypeScript `entity`, C# `entity`, Java `value-object`, Kotlin `entity` and Python `entity`. It
   emits the type **whether or not an entity reaches the object**: being reachable from a template
   is reason enough for a type to exist.

2. **The template tier declares no type for a value object.** Payload records, render helpers and
   handles, output parsers, extractors and output-prompt fragments *reference* the rule-1 type by
   its canonical name and location (import, FQN or `using`). The request payload type of a
   template **is** its `@payloadRef` object's type, and the strict parse result of a responding
   prompt **is** its `@responseRef` object's type. Nothing is named after the template.

3. **A shape derived from a value object is keyed by the value object, not the template.** Where
   the template tier needs a genuinely different shape (the lenient all-optional extraction mirror
   `<X>Extracted`), it is named after the value object, emitted into the value object's own
   package or module, and emitted once per run. Where it lands never depends on which template
   reached it first.

4. **Template-keyed artifacts stay template-keyed.** Anything a template owns (the render
   function, the parser object, the output-format fragment) stays where it is today, named after
   the template, and references the rule-1 and rule-3 types.

5. **The `payload` generator is removed** from C#, Java, Kotlin and Python. It has nothing left
   to emit. TypeScript's `promptRender()` keeps its render handles and loses its interface
   emission.

6. **The template tier requires the value-object generator.** A run that wires a template-tier
   generator must also wire the value-object generator; otherwise the references in rule 2 point
   at nothing. Every template-tier generator's documentation, the catalog entry and each port's
   codegen reference say so. No port enforces it at generation time: generators do not see the
   rest of the run's selection, and adding that seam is out of scope here. Each port's
   codegen-compile gate generates the two tiers together, so the reference output is proven to
   compile as a pair.

### Port-specific consequences of rule 2

- **Kotlin:** the strict parser decodes with **Jackson** (`jackson-module-kotlin`), not kotlinx.
  The entity-tier data classes carry no `@Serializable`: that annotation was decorative, and no
  build enables the kotlinx compiler plugin. Enums keep `@Serializable`, which is harmless.
- **Java:** `SpringValueObjectGenerator`'s records carry jakarta bean-validation constraints. A
  template-only adopter therefore needs `jakarta.validation-api` on the classpath, as every Spring
  web adopter already has.
- **Python:** the request payload's `extra="forbid"` goes away. It existed only on the template
  tier's copy, and the value object's model keeps pydantic's default. Payload bloat stays
  detectable through `verify`'s mustache-versus-payload check. What Python loses is the
  construction-time check for a mistyped keyword argument, which the other four ports get from
  their compilers.
- **TypeScript:** an optional field is `name?: T`, as the value object declares it, not the
  payload copy's `name?: T | null`. A caller that builds a payload from a Drizzle row coalesces
  `null` to `undefined` (`row.x ?? undefined`).

## Consequences

- **#387 is fixed by construction.** No type's location depends on which template reached it.
- **ADR-0044's payload-tier naming retires.** On the JVM, packages disambiguate by
  themselves. TypeScript, C# and Python emit value-object types into one flat namespace or
  directory, so there the value-object generator applies ADR-0044's collision naming to its own
  types and the template tier asks it for the emitted name instead of computing one.
  `ERR_PAYLOAD_NAME_COLLISION` survives only there. (This paragraph originally said C#
  disambiguated by namespace and that Python already applied the naming; both were wrong — see
  Amendment 1.)
- **Generated output changes for every adopter who uses templates.** Payload types move from
  `<pkg>.prompts.XPayload` (or `prompts.ts`, or a template's module) to the value object's own
  location. Callers change their imports, and render helpers take the value object's type. The
  release notes and migration guide say so.
- **The generator catalog shrinks.** `payload` disappears from `generator-registry-conformance`
  and from the C# and Python CLIs' `--generators` vocabulary.

## Amendment 1 (2026-09-22) — what the ports actually do

Written when the five ports had been implemented, to correct three statements above that the
implementation proved wrong.

1. **Collision naming is needed in C# and was added to Python.** C#'s default package binding
   (`UnmappedStrategy.Flatten`) puts every package into one namespace and every generated file
   into one directory, so two value objects named `Note` — or a value object `Report` and an
   entity `Report` in another package — collided on the type and on the file name. C#
   (`ValueObjectNames`) and Python (`codegen/value_objects.py`) qualify a value object whose
   short name ANY top-level object shares (`acme::alpha::Note` → `AcmeAlphaNote`); entities and
   projections keep their names. TypeScript qualifies only among value objects. Python's entity
   generator had applied no collision naming before this change: its value-object modules were
   written as `<name>.py`, so two `Note`s both wrote `Note.py`.

2. **Rule 3's mirror placement differs by port.** Kotlin and C# emit each `<X>Extracted` mirror
   once per run, as its own file beside the value object, exactly as rule 3 says. TypeScript and
   Python keep the mirror module-local — declared inside each parser module that needs it — and
   name it after the value object. A module scopes the name, so two parsers over one response
   each carry a copy without clashing, and where it lands still never depends on which template
   reached it first. Java has no mirror type: its tolerant tier maps into the record directly.
   The rule's intent — keyed by the value object, independent of template order — holds in all
   five; its "emitted into the value object's own package" clause holds in Kotlin and C# only.

3. **Rule 6 is enforced, advisorily, in three ports — and no compile gate proves the pair.**
   TypeScript's catalog marks `prompt-render`, `output-parser`, `render-helper` and
   `trace-helper` `requires: ["entity"]`, and the runner warns when one is wired without it.
   Python marks `output-parser`, `extractor` and `render-helper` the same way; `gen --list` shows
   it and `--generators` warns. C#'s `--list` notes the requirement for `output-parser`,
   `extractor` and `render-helper`. Java and Kotlin say so in documentation only. The closing
   sentence of rule 6 was also wrong: every port's codegen-compile gate generates from
   `persistence-conformance/canonical/meta.fitness.json`, which declares no `template.*`, so the
   gate never runs the template tier. What proves the pair compiles is each port's template-tier
   tests, which generate both tiers together and compile, import or run the result — for
   example Kotlin's `KotlinTemplateTierValueObjectTest`, Java's
   `OutputParserExtractTierCollisionTest`, and Python's `test_extract_tier_collision.py`.

## Alternatives considered

- **One copy per consuming package (the #387 proposal).** Rejected: it fixes the compile error by
  multiplying the duplication, and the copies are not interchangeable across packages.
- **Hybrid: move a value object only once two or more packages reach it.** Rejected: where a type
  lands becomes a function of how many templates use it, so adding a second consumer moves the
  first consumer's type.
- **Keep a payload family, fix only the placement.** Rejected: it keeps two definitions of one
  shape, and every past divergence between them (nullability, enum naming, field-type maps) came
  from having two.
