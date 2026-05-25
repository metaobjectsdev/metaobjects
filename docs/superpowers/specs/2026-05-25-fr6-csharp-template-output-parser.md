# FR6-csharp — C# `template.output` parser codegen (sketch)

**Status:** Design proposal — needs brainstorm before implementation (lighter brainstorm than TS — C# codegen layer is already mature)
**Date:** 2026-05-25
**Scope:** C# — `MetaObjects.Codegen` (parser emission) + `meta verify` extension (C# CLI per CLAUDE.md)
**Depends on:** [ADR-0010](../../../spec/decisions/ADR-0010-template-output-parser-codegen.md); existing `MetaObjects.Render` + `MetaObjects.Codegen` (shipped per CLAUDE.md status)
**Parent:** [FR6 cross-port design](./2026-05-25-fr6-template-output-parser-codegen.md)

## Goal

For every declared `template.output`, the C# codegen emits a parser class with the
dual-API shape from ADR-0010 (matching .NET BCL `Parse`/`TryParse` convention):

```csharp
// Generated NpcResponse.Output.cs
public static class NpcResponseOutputParser {
    private static readonly JsonSerializerOptions Options = new() {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    };

    /// <summary>Parse an LLM response into a typed NpcResponse.</summary>
    /// <exception cref="JsonException">when JSON parse fails or shape doesn't match.</exception>
    public static NpcResponse Parse(string text) =>
        JsonSerializer.Deserialize<NpcResponse>(text, Options)
            ?? throw new JsonException("null response");

    /// <summary>Parse with Result-style return; does not throw.</summary>
    public static bool TryParse(string text, out NpcResponse? result, out JsonException? error) {
        try { result = JsonSerializer.Deserialize<NpcResponse>(text, Options); error = null; return result is not null; }
        catch (JsonException ex) { result = null; error = ex; return false; }
    }
}
```

Plus `meta verify` extension (C# CLI's `verify` command per CLAUDE.md).

## Why this is a sketch, not implementation-ready

The design largely follows the TS FR6 shape but with .NET idioms. The brainstorm
items expected:

1. **Source-generator vs reflection.** .NET AOT prefers source generators (per
   ADR-0001's reflection-replacement principle). The TS port uses Zod (runtime
   validation). The C# port should use `System.Text.Json` source generators for AOT
   compatibility — but this needs confirmation against the existing C# codegen
   patterns. Existing `MetaObjects.Codegen` may already establish a preference.
2. **JsonNamingPolicy.** C# convention is PascalCase properties; JSON convention is
   camelCase. The existing C# codegen for entities + payload-VOs has presumably
   already made this choice. The output parser should match.
3. **Nullable reference type contracts.** `Parse` returns `T` non-null; `TryParse`'s
   `out result` is `T?`. Match existing `MetaObjects.Codegen` patterns.

## Tests + verification

- Unit tests on the field-type → System.Text.Json attribute mapping.
- Golden tests under `MetaObjects.Codegen.Tests/Golden/` matching existing
  C# codegen test patterns.
- New conformance fixture `template-output-simple` shares structure with TS; C#
  conformance runner verifies `expected/NpcResponseOutput.Output.cs` byte-match.
- `meta verify --kind output` tests under the C# CLI test project.

## Out of scope

Same exclusions as FR6 parent.

## Open questions

To be settled during the lighter brainstorm:

1. System.Text.Json source generator vs runtime reflection.
2. JsonNamingPolicy choice (probably already established by existing C# codegen).
3. Whether to ship a barrel/index file aggregating all output parsers, or stay file-per-template (matches C# codegen layout established by existing entity emit).
