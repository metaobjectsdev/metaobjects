# C# parser-on-receipt

For every RESPONDING `template.prompt` — one declaring `@responseRef` —
`MetaObjects.Codegen`'s `OutputParserGenerator` emits a **typed parser** that validates
a model's reply against that shape. ADR-0052: the tier binds `@responseRef`, never
`@payloadRef` (which types the request the prompt renders outbound), and a
`template.output` gets no parser at all. This is the receive side only — codegen emits
**no** provider/LLM-call layer; you compose the call yourself. C# names records after the
resolved VALUE OBJECT, so the response record simply IS that VO's record — no second
naming convention, and the parser and the record can't silently drift.

## Contents
- Wire the generator
- What it emits
- The response-format prompt fragment (FR-010)
- The three-step consumer pattern
- Recommended LLM caller (bring-your-own)
- Consumer dependency
- Drift gate

## Wire the generator

`OutputParserGenerator` (stable name `output-parser`) runs as part of
`dotnet meta gen`, alongside the payload generator that emits the record it parses
into:

```bash
dotnet meta gen ./metadata --out ./Generated --namespace Acme.Blog
```

## What it emits

Per responding `template.prompt`, `dotnet meta gen` writes one
`<PromptName>.response.cs` with a static `<PromptName>Parser` following the .NET BCL
`Parse`/`TryParse` dual API. The strict tier is JSON-only — an `@responseFormat: xml`
reply gets the tolerant extract and neither `Parse` nor `TryParse` —
`Parse` throws, `TryParse` returns a bool plus an out-error:

```csharp
// generated <PromptName>.response.cs (shape)
public static class NpcResponseParser
{
    /// <exception cref="JsonException">malformed JSON or schema mismatch.</exception>
    public static NpcResponse Parse(string text) =>
        JsonSerializer.Deserialize<NpcResponse>(text, Options)
            ?? throw new JsonException("deserialized to null");

    public static bool TryParse(string text,
        [NotNullWhen(true)] out NpcResponse? value,
        [NotNullWhen(false)] out string? error) { /* ... */ }
}
```

The `[NotNullWhen]` attrs let nullable-flow analysis use `value` without a null-check
after a `true` return (and `error` after `false`). For `@format: json|xml` outputs the
generator also emits a tolerant `Extract(string[, ExtractOptions])` (self-contained) +
`Extract(MetaObject, string, ...)` (runtime-delegating, fully populating nested
components) returning an `ExtractionResult` with a nullable `<Payload>Extracted` mirror
— a classified per-field report rather than a throw.

## The response-format prompt fragment (FR-010)

For every responding `template.prompt`, `MetaObjects.Codegen`'s `OutputPromptGenerator`
(stable name `output-prompt-generator`) emits a `<PromptName>.responseFormat.cs`
declaring a static `<PromptName>ResponseFormat` class with a `RenderFormat()` /
`RenderFormat(PromptOverrides)` pair, backed by the render engine's
`OutputFormatRenderer` — the "produce your answer like this" fragment for the model. It runs as part of the same `dotnet meta gen` invocation as the payload
and parser generators:

```bash
dotnet meta gen ./metadata --out ./Generated --namespace Acme.Blog
```

`@promptStyle` on the `template.prompt` (`guide` default / `inline` / `exampleOnly`)
controls the fragment's presentation; guidance is never emitted as comments. Skipped for
`template.output` nodes and an unresolved `@responseRef` — the same skip contract as the
parser generator. There is NO format gate: the old `@format ∈ {json,xml}` test read the
syntax of the outbound body to decide whether to describe the reply. The baked spec's
root name is the response record's, agreeing with the parser's root.

## The three-step consumer pattern

Render the prompt → call your LLM client (provider-agnostic; nothing is generated
here) → parse the response with the generated parser:

```csharp
string llmResponse = await myLlmClient.CompleteAsync(promptText);   // YOUR code — no generated provider

// Throwing path
var npc = NpcResponseParser.Parse(llmResponse);

// TryParse for explicit error handling
if (NpcResponseParser.TryParse(llmResponse, out var npc, out var error))
    return Ok(npc);
return BadRequest(new { error });
```

## Recommended LLM caller (bring-your-own)

`dotnet meta gen` emits **no** provider/LLM-call layer and never will — calling is a
commodity the ecosystem already solves (ADR-0024). You bring the caller; MetaObjects
owns the typed render → parse (above) → record. For the call step use the idiomatic
.NET library:

```csharp
using Microsoft.Extensions.AI;   // recommended — IChatClient is provider-agnostic

IChatClient client = /* an Anthropic / OpenAI / Azure IChatClient */;
ChatResponse resp = await client.GetResponseAsync(promptText);
string text = resp.Text;

var npc = NpcResponseParser.Parse(text);   // the generated parser, above
```

**Recommended: Microsoft.Extensions.AI** (`IChatClient`) — the emerging
provider-agnostic .NET standard; its one-method shape matches MetaObjects' call seam.
For higher-level agent orchestration, **Semantic Kernel** layers on top of the same
`IChatClient`.

> The typed-trace recorder + render→call→record convenience loop ship in TypeScript
> today; the C# port is planned (ADR-0024). Until then the call is your code and the
> generated parser is the typed receive side.

## Consumer dependency

`System.Text.Json` ships in the .NET 8 BCL — no NuGet to add. The generated parser
uses strict (case-sensitive) options.

## Drift gate

`MetaObjects.Render`'s `Verify.Check(string templateText, IReadOnlyList<PayloadField>
fields, VerifyOptions? options = null) -> IReadOnlyList<VerifyError>` walks a Mustache
template's tokens against the payload field tree — each `{{...}}` that doesn't resolve
yields a `VerifyError(Code, Path)` (empty list = no drift). Assert it is empty in an
xUnit test to fail the build on prompt/payload drift; `dotnet meta verify` additionally
catches a stale committed parser.
