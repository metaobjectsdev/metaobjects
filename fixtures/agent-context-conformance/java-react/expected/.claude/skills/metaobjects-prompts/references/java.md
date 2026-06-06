# Java parser-on-receipt

For every `template.output`, `codegen-spring`'s `SpringOutputParserGenerator` emits
a **typed parser** that validates an LLM/raw response against the template's
`@payloadRef` payload record. This is the receive side only — codegen emits **no**
provider/LLM-call layer; you compose the call yourself.

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

Per `template.output`, `mvn metaobjects:generate` writes a `<Name>Parser` class with a static
`parse` method returning the `@payloadRef` payload record. The strict path throws
`com.fasterxml.jackson.core.JsonProcessingException` on malformed input:

```java
// generated <Name>Parser.java (shape)
public final class NpcResponseParser {
    private NpcResponseParser() { }   // no instances

    public static NpcResponsePayload parse(String text) throws JsonProcessingException {
        // Jackson-backed: validates the text against the payload record
    }
}
```

For `@format: json|xml` outputs the generator also emits a tolerant best-effort
variant (`extractLenient(...)` returning an `ExtractionResult<NpcResponsePayload>`
from `com.metaobjects.render.extract`) for cases where you want classification
rather than a throw. The payload record itself comes from `SpringPayloadGenerator`
— the parser is a companion to it, so the parser and payload VO can't silently
drift.

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

> The typed-trace recorder + render→call→record convenience loop ship in TypeScript
> today; the JVM port is planned (ADR-0024). Until then the call is your code and the
> generated parser is the typed receive side.

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
