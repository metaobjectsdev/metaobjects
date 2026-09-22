# Kotlin parser-on-receipt

For every RESPONDING `template.prompt` — one declaring `@responseRef` —
`codegen-kotlin`'s `KotlinOutputParserGenerator` emits a **typed parser** that validates
a model's reply against that shape. ADR-0052: the tier binds `@responseRef`, never
`@payloadRef` (which types the request the prompt renders outbound), and a
`template.output` gets no parser at all. This is the receive side only — codegen emits
**no** provider/LLM-call layer; you compose the call yourself. The data class it returns
is the `@responseRef` value object's own, from `KotlinEntityGenerator` in the value
object's package (ADR-0056 — the template tier declares no copy), so the parser and the
data class can't silently drift.

## Contents
- Wire the generators
- What it emits
- The response-format prompt fragment (FR-010)
- The three-step consumer pattern
- Consumer dependency
- Recommended LLM caller (bring-your-own)
- Drift gate

## Wire the generators

Add `KotlinOutputParserGenerator` (alongside `KotlinEntityGenerator`, which emits the
value object's data class it parses into) to the Maven plugin's `<generators>` list:

```xml
<generator>
  <classname>com.metaobjects.generator.kotlin.KotlinEntityGenerator</classname>
  <args><outputDir>${project.build.directory}/generated-sources/kotlin</outputDir></args>
</generator>
<generator>
  <classname>com.metaobjects.generator.kotlin.KotlinOutputParserGenerator</classname>
  <args><outputDir>${project.build.directory}/generated-sources/kotlin</outputDir></args>
</generator>
```

## What it emits

Per responding `template.prompt`, `mvn metaobjects:generate` writes a
`<Name>Parser.kt` `object` with a dual API: a Jackson-backed throwing parse plus the
Kotlin stdlib `Result<T>` convention. The strict tier is JSON-only — an
`@responseFormat: xml` reply gets the tolerant extract and neither strict function:

```kotlin
// generated <Name>Parser.kt (shape)
import acme.ai.NpcReply   // the @responseRef value object's own data class

object NpcResponseParser {
    private val mapper = jacksonObjectMapper().findAndRegisterModules()

    /** @throws com.fasterxml.jackson.core.JsonProcessingException on bad input. */
    fun parseNpcResponse(text: String): NpcReply =
        mapper.readValue(text, NpcReply::class.java)

    /** Result-style — does not throw. */
    fun safeParseNpcResponse(text: String): Result<NpcReply> =
        runCatching { parseNpcResponse(text) }
}
```

The generator additionally emits a **tolerant** best-effort variant —
`extractLenient(...)` returning an `ExtractionResult<NpcReplyExtracted>` (from
`com.metaobjects.render.extract`) for
cases where you want a classified per-field report rather than a throw. There are
two overloads: a self-contained one (scalars/enums only; nested components stay
null) and a `extractLenient(loader, text)` overload that delegates to the runtime
`MetaObjectExtractor` to fully populate nested-object and array-of-object
components. The lenient mirror type (`<Vo>Extracted`, named after the value object and
written once per run beside it) uses nullable fields per the Kotlin null-safety port — a
missing/malformed component is `null`, not a throw.

## The response-format prompt fragment (FR-010)

For every responding `template.prompt`, `codegen-kotlin`'s
`KotlinOutputPromptGenerator` emits a `<PromptShortName>ResponseFormat.kt` `object`
with `renderFormat()` / `renderFormat(overrides: PromptOverrides)`, backed by
`OutputFormatRenderer` from the `metaobjects-render` module — the "produce your
answer like this" fragment for the model. Wire it alongside
`KotlinOutputParserGenerator` in the Maven plugin's `<generators>` list:

```xml
<generator>
  <classname>com.metaobjects.generator.kotlin.KotlinOutputPromptGenerator</classname>
  <args><outputDir>${project.build.directory}/generated-sources/kotlin</outputDir></args>
</generator>
```

`@promptStyle` on the `template.prompt` (`guide` default / `inline` / `exampleOnly`)
controls the fragment's presentation; guidance is never emitted as comments. Skipped for
`template.output` nodes and an unresolved `@responseRef` — the same skip contract as the
parser generator. There is NO format gate: the old `@format ∈ {json,xml}` test read the
syntax of the outbound body to decide whether to describe the reply. The `SPEC`'s root
name is the response value object's short name, as in every port.

## The three-step consumer pattern

Render the prompt → call your LLM client (provider-agnostic; nothing is generated
here) → parse the response with the generated parser:

```kotlin
val response: String = myLlmClient.complete(promptText)   // YOUR code — no generated provider

// Throwing path — propagate to your error handler
val npc = NpcResponseParser.parseNpcResponse(response)

// Or Result-style
NpcResponseParser.safeParseNpcResponse(response)
    .onSuccess { npc -> /* use it */ }
    .onFailure { ex -> log.warn("LLM returned malformed payload", ex) }
```

## Consumer dependency

The emitted strict parser decodes with Jackson's Kotlin module
(`jacksonObjectMapper().readValue(...)`), the codec the value objects' data classes are
built for — add it if your build does not already have it:

```kotlin
dependencies {
    implementation("com.fasterxml.jackson.module:jackson-module-kotlin:2.x")
}
```

No kotlinx-serialization plugin is needed: the data classes carry no `@Serializable`.

## Recommended LLM caller (bring-your-own)

`codegen-kotlin` emits **no** provider/LLM-call layer and never will — calling is a
commodity the ecosystem already solves (ADR-0024). You bring the caller; MetaObjects
owns the typed render → parse (above) → record. For the call step use the idiomatic
JVM library — Kotlin calls either directly:

```kotlin
// Spring AI (recommended) — provider-agnostic ChatClient; YOUR code, no generated provider
val response: String = chatClient.prompt()
    .system(systemText)
    .user(promptText)
    .call()
    .content()

val npc = NpcResponseParser.parseNpcResponse(response)   // the generated parser, above
```

**Recommended: Spring AI** (`ChatClient`) for a Spring app, or **LangChain4j**
(`ChatLanguageModel.generate(prompt)`) for non-Spring JVM — both provider-agnostic,
both a one-call seam Kotlin uses idiomatically.

> The typed-trace **recorder** has shipped on the JVM — `codegen-spring`'s
> `LlmTraceHelperGenerator` emits a Java `record<Entity>(...)` helper (per concrete
> entity extending `LlmCallBase` with a `@responseRef`-carrying `template.prompt`);
> Kotlin code calls it directly (same JVM, same classpath) — there is no separate
> Kotlin-native (`codegen-kotlin`/KotlinPoet) trace-helper emitter yet. What's TS-only
> is the **`call<Entity>` render→call→record convenience loop** — neither JVM
> generator emits it, because the `LlmClient` seam it wraps is BYO / vendor-neutral on
> the JVM (ADR-0024). So you compose render → your LLM call → the generated Java
> `record<Entity>(...)` yourself; the parser above is the standalone receive side if
> you don't even want the recorder.

## Drift gate

The render engine is the Java `metaobjects-render` module (Kotlin wraps it). Its
static `Verify.check(...)` walks a Mustache template's tokens against the payload
field tree and returns a list of errors for any `{{...}}` reference that doesn't
resolve against the payload — empty list = no drift. Assert it is empty in a JUnit
test in the Maven `test` phase to fail the build on prompt/payload drift. The
`metaobjects:verify` codegen-drift goal additionally catches a stale committed
parser.
