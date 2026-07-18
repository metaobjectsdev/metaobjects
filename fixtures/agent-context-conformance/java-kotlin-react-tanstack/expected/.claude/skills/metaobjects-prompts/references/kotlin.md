# Kotlin parser-on-receipt

For every `template.output`, `codegen-kotlin`'s `KotlinOutputParserGenerator` emits
a **typed parser** that validates an LLM/raw response against the template's
`@payloadRef` payload data class. This is the receive side only — codegen emits
**no** provider/LLM-call layer; you compose the call yourself. The payload data
class itself comes from `KotlinPayloadGenerator` (a `@Serializable data class`), so
the parser and the payload VO can't silently drift.

## Contents
- Wire the generators
- What it emits
- The output-format prompt fragment (FR-010)
- The three-step consumer pattern
- Consumer dependency
- Recommended LLM caller (bring-your-own)
- Drift gate

## Wire the generators

Add `KotlinOutputParserGenerator` (alongside `KotlinPayloadGenerator`, which emits
the payload it parses into) to the Maven plugin's `<generators>` list:

```xml
<generator>
  <classname>com.metaobjects.generator.kotlin.KotlinPayloadGenerator</classname>
  <args><outputDir>${project.build.directory}/generated-sources/kotlin</outputDir></args>
</generator>
<generator>
  <classname>com.metaobjects.generator.kotlin.KotlinOutputParserGenerator</classname>
  <args><outputDir>${project.build.directory}/generated-sources/kotlin</outputDir></args>
</generator>
```

## What it emits

Per `template.output`, `mvn metaobjects:generate` writes a `<Name>Parser.kt`
`object` with a dual API matching kotlinx.serialization's exception model plus the
Kotlin stdlib `Result<T>` convention:

```kotlin
// generated <Name>Parser.kt (shape)
object NpcResponseParser {
    private val json: Json = Json { ignoreUnknownKeys = false }

    /** Throws kotlinx.serialization.SerializationException on bad input. */
    fun parseNpcResponse(text: String): NpcResponsePayload =
        json.decodeFromString<NpcResponsePayload>(text)

    /** Result-style — does not throw. */
    fun safeParseNpcResponse(text: String): Result<NpcResponsePayload> =
        runCatching { parseNpcResponse(text) }
}
```

For `@format: json|xml` outputs the generator additionally emits a **tolerant**
best-effort variant — `extractLenient(...)` returning an
`ExtractionResult<NpcResponseExtracted>` (from `com.metaobjects.render.extract`) for
cases where you want a classified per-field report rather than a throw. There are
two overloads: a self-contained one (scalars/enums only; nested components stay
null) and a `extractLenient(loader, text)` overload that delegates to the runtime
`MetaObjectExtractor` to fully populate nested-object and array-of-object
components. The lenient mirror type (`<Name>Extracted`) uses nullable fields per
the Kotlin null-safety port — a missing/malformed component is `null`, not a throw.

## The output-format prompt fragment (FR-010)

For every json/xml-format `template.output`, `codegen-kotlin`'s
`KotlinOutputPromptGenerator` emits a `<TemplateShortName>OutputPrompt.kt` `object`
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

`@promptStyle` on the `template.output` (`guide` default / `inline` / `exampleOnly`)
controls the fragment's presentation; guidance is never emitted as comments. Skipped
for `template.prompt` nodes, non-json/xml `@format`, and unresolved `@payloadRef` —
the same skip contract as the parser generator. The `SPEC`'s root name is the
capitalized payload class name, agreeing with the parser's extract-codegen root.

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

The emitted parser imports `kotlinx.serialization.json.Json` and calls
`Json.decodeFromString<T>(text)`. The `kotlinx-serialization-core` artifact alone
(which `@Serializable` needs) does NOT include the JSON format — add the JSON
artifact + the serialization plugin:

```kotlin
plugins { kotlin("plugin.serialization") version "1.9.x" }
dependencies {
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.x")
}
```

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
