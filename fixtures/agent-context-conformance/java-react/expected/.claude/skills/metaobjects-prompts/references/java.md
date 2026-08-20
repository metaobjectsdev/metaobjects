# Java parser-on-receipt

For every RESPONDING `template.prompt` — one declaring `@responseRef` —
`codegen-spring`'s `SpringOutputParserGenerator` emits a **typed parser** that validates
a model's reply against that shape. ADR-0052: the tier binds `@responseRef`, never
`@payloadRef` (which types the request the prompt renders outbound), and a
`template.output` gets no parser at all. This is the receive side only — codegen emits
**no** provider/LLM-call layer; you compose the call yourself.

## Contents
- Wire the generator
- What it emits
- The response-format prompt fragment (FR-010)
- The three-step consumer pattern
- Recommended LLM caller (bring-your-own)
- Drift gate

## Wire the generator

Add `SpringOutputParserGenerator` (alongside `SpringPayloadGenerator`, which emits
the payload record it parses into) to the Maven plugin's `<generators>` list:

```xml
<generator>
  <classname>com.metaobjects.generator.spring.SpringPayloadGenerator</classname>
  <args><outputDir>${project.build.directory}/generated-sources/java</outputDir></args>
</generator>
<generator>
  <classname>com.metaobjects.generator.spring.SpringOutputParserGenerator</classname>
  <args><outputDir>${project.build.directory}/generated-sources/java</outputDir></args>
</generator>
```

## What it emits

Per responding `template.prompt`, `mvn metaobjects:generate` writes a `<Name>Parser`
class with a static `parse` method returning the `<Name>Response` record — this port's
records are TEMPLATE-named, so a responding prompt gets a SECOND record beside
`<Name>Payload`. The strict path throws
`com.fasterxml.jackson.core.JsonProcessingException` on malformed input, and is
JSON-only: an `@responseFormat: xml` reply gets the tolerant extract and no `parse`:

```java
// generated <Name>Parser.java (shape)
public final class NpcResponseParser {
    private NpcResponseParser() { }   // no instances

    public static NpcResponseResponse parse(String text) throws JsonProcessingException {
        // Jackson-backed: validates the text against the @responseRef record
    }
}
```

For `@format: json|xml` outputs the generator also emits a tolerant best-effort
variant (`extractLenient(...)` returning an `ExtractionResult<NpcResponsePayload>`
from `com.metaobjects.render.extract`) for cases where you want classification
rather than a throw. The payload record itself comes from `SpringPayloadGenerator`
— the parser is a companion to it, so the parser and payload VO can't silently
drift.

Both `parse()` and `extractLenient(...)` here return **plain Java 21 records** —
safe with any mapper, nothing special needed. That's specific to this
`codegen-spring` extract tier: the codegen-base flavored `<Name>Extractor` and the
raw `MetaObjectExtractor` (the alternative extraction path, see the codegen
reference) return `MetaObjectAware` instances instead, and those need
`JsonObjectWriter`/`MetaObjectSerializer` — not a bare mapper — to serialize
correctly (see the codegen reference's "Serializing generated objects" section).

## The response-format prompt fragment (FR-010)

For every responding `template.prompt`, `codegen-spring`'s
`SpringOutputPromptGenerator` emits a `<PromptShortName>ResponseFormat` class with a
static `renderFormat()` / `renderFormat(PromptOverrides)` pair, backed by
`OutputFormatRenderer` from the `metaobjects-render` module — the "produce your
answer like this" fragment for the model. Wire it alongside
`SpringOutputParserGenerator` in the Maven plugin's `<generators>` list:

```xml
<generator>
  <classname>com.metaobjects.generator.spring.SpringOutputPromptGenerator</classname>
  <args><outputDir>${project.build.directory}/generated-sources/java</outputDir></args>
</generator>
```

`@promptStyle` on the `template.prompt` (`guide` default / `inline` / `exampleOnly`)
controls the fragment's presentation; guidance is never emitted as comments. Skipped for
`template.output` nodes and an unresolved `@responseRef` — the same skip contract as the
parser generator. There is NO format gate: the old `@format ∈ {json,xml}` test read the
syntax of the outbound body to decide whether to describe the reply. The `SPEC`'s root
name is the response record's, agreeing with the parser's extract-codegen root.

## The three-step consumer pattern

Render the prompt → call your LLM client (provider-agnostic; nothing is generated
here) → parse the response with the generated parser:

```java
String promptText = Renderer.render(/* template ref + payload + provider */);
String llmResponse = myLlmClient.call(promptText);     // YOUR code — no generated provider

NpcResponsePayload npc = NpcResponseParser.parse(llmResponse);   // throws on bad shape
```

## Recommended LLM caller (bring-your-own)

`codegen-spring` emits **no** provider/LLM-call layer and never will — calling is a
commodity the ecosystem already solves, and a maintained vendor wrapper would chase
SDK churn (ADR-0024). You bring the caller; MetaObjects owns the typed render →
parse (above) → record. For the call step use the idiomatic JVM library:

```java
// Spring AI (recommended) — provider-agnostic ChatClient; YOUR code, no generated provider
String response = chatClient.prompt()
    .system(systemText)
    .user(promptText)
    .call()
    .content();

NpcResponsePayload npc = NpcResponseParser.parse(response);   // the generated parser, above
```

**Recommended: Spring AI** (`ChatClient`) — Spring-native, provider-agnostic
(Anthropic / OpenAI / Azure / Bedrock / Ollama), fits an OMDB + Spring-tx app.
Non-Spring JVM apps: **LangChain4j** (`ChatLanguageModel.generate(prompt)`) is the
equivalent one-call seam.

> The typed-trace **recorder** has shipped on this port too — `LlmTraceHelperGenerator`
> emits a `record<Entity>(...)` helper (per concrete entity extending `LlmCallBase`
> with a `@responseRef`-carrying `template.prompt`) that extracts the typed response,
> builds the base trace row, and persists it via the OMDB `LlmCallRecorder` seam. What's
> still TS-only is the **`call<Entity>` render→call→record convenience loop** — Java
> intentionally does not emit it, because the `LlmClient` seam it wraps is BYO /
> vendor-neutral here (ADR-0024). So you compose render → your LLM call → the
> generated `record<Entity>(...)` yourself; the parser above is the standalone
> receive side if you don't even want the recorder.

## Drift gate

The render module's static `Verify.check(String templateText, List<PayloadField> fields, VerifyOptions options)`
walks a Mustache template's tokens against a payload field tree and returns a
`List<VerifyError>` — each `{{...}}` reference that doesn't resolve against the
payload fields yields an error (empty list = no drift). `VerifyOptions.empty()`
supplies a fully-defaulted options record; `VerifyOptions(provider, requiredSlots,
requiredTags)` adds partial resolution and required-slot/-tag checks. For the
output-format fragment specifically, `Verify.checkOutputPrompt(String fragment,
List<String> requiredFieldNames)` returns a `List<VerifyError>` for every required
field name absent from the rendered fragment. Assert the returned list is empty in a
JUnit test in the Maven `test` phase to fail the build on prompt/payload drift. The
`metaobjects:verify` codegen-drift goal additionally catches a stale committed
parser. The emitted parser imports Jackson (`com.fasterxml.jackson`), normally
already on a Spring Boot classpath.
