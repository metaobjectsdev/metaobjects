# C# parser-on-receipt

For every `template.output`, `MetaObjects.Codegen`'s `OutputParserGenerator` emits a
**typed parser** that validates an LLM/raw response against the template's
`@payloadRef` payload record. This is the receive side only — codegen emits **no**
provider/LLM-call layer; you compose the call yourself. The payload record comes from
the payload generator, so the parser and the payload VO can't silently drift.

## Contents
- Wire the generator
- What it emits
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

Per `template.output`, `dotnet meta gen` writes one `<TemplateName>.output.cs` with a
static `<TemplateName>Parser` following the .NET BCL `Parse`/`TryParse` dual API —
`Parse` throws, `TryParse` returns a bool plus an out-error:

```csharp
// generated <TemplateName>.output.cs (shape)
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
