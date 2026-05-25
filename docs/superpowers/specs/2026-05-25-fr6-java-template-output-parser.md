# FR6-java — Java `template.output` parser codegen (sketch, gated)

**Status:** Design sketch — gated on Java codegen layer (planned in H4)
**Date:** 2026-05-25
**Scope:** Java — codegen target (planned per roadmap H4: "TS codegen Java target — Refactor TS codegen to pluggable targets; Java target emits Spring JDBC DAOs, Spring MVC controllers, POJOs")
**Depends on:** [ADR-0010](../../../spec/decisions/ADR-0010-template-output-parser-codegen.md); Java codegen layer existing (not yet)
**Parent:** [FR6 cross-port design](./2026-05-25-fr6-template-output-parser-codegen.md)

## Goal

For every declared `template.output`, the Java codegen emits a parser class with
the Java throw-only convention (matching Jackson):

```java
// Generated NpcResponseOutputParser.java
public final class NpcResponseOutputParser {
    private static final ObjectMapper MAPPER = new ObjectMapper()
        .registerModule(new JavaTimeModule());

    /**
     * Parse an LLM response into a typed NpcResponse.
     *
     * @throws JsonProcessingException when JSON parse or schema validation fails
     */
    public static NpcResponse parseNpcResponse(String text) throws JsonProcessingException {
        return MAPPER.readValue(text, NpcResponse.class);
    }
}
```

Plus eventual `meta verify` extension when a Java CLI surfaces (today's
metaobjects CLI is TS; Java may share or grow its own).

## Why this is a sketch — implementation gated

Java doesn't have a codegen layer yet. Per roadmap H4: "TS codegen Java target —
2-3 wk." When that ships, this FR ships alongside as one of the codegen targets
the Java codegen produces.

## Design (when ready)

### Jackson alignment

Jackson is the de facto JSON-parsing library in the Java ecosystem. Spring Boot
defaults to it; most LLM-Java libraries use it. The generated parser uses
`ObjectMapper.readValue(text, Xxx.class)` — the canonical Jackson call.

The Java codegen layer (per H4) will already need to make Jackson-vs-Gson-vs-other
decisions for entity and payload-VO emission; the output parser inherits that
choice.

### No dual API

Java doesn't have an idiomatic dual-API precedent like .NET's `Parse`/`TryParse`.
Jackson throws `JsonProcessingException`; callers wrap in try/catch. Matching the
ecosystem norm, the generated parser is single-API throw-only.

If a Java adopter wants a Result-style API, they wrap the call themselves —
likely using Vavr's `Try<T>` or a hand-rolled `Result<T>` type. The codegen
doesn't bless one.

### Field-type → Jackson-annotation mapping

The payload-VO (POJO emitted by the Java codegen) carries Jackson annotations:

| Field subtype | Jackson / POJO shape |
|---|---|
| `field.string` | `String` (with `@JsonProperty` for camelCase if needed) |
| `field.int` / `field.long` / `field.short` / `field.byte` | matching primitive or boxed |
| `field.double` / `field.float` | matching primitive or boxed |
| `field.boolean` | `boolean` |
| `field.date` / `field.time` / `field.timestamp` | `java.time.{LocalDate, LocalTime, Instant}` |
| `field.enum` | Java `enum` |
| `field.currency` | `long` (minor units) |
| `field.object` | nested POJO |
| `isArray: true` | `List<...>` |

## Out of scope

Same exclusions as FR6 parent. Plus: no Java implementation until the codegen
layer ships (gated on H4).

## Open questions

When implementation time comes:

1. Jackson vs Gson vs other (presumably settled by the broader Java codegen design
   in H4).
2. Whether to emit a separate parser class or add a `parse` static method to the
   POJO itself (Java conventions vary).
3. `meta verify` story for Java — whether to ship a Java CLI extension or rely on
   the TS CLI (TS CLI can verify Java metadata since metadata is language-agnostic).
