// The C# native SDK api-surface IR (intermediate representation).
//
// Mirrors the Java JavaApiModel IR (server/java/.../apidocs) and the TS api-model.ts,
// idiomatic to the C# (EF Core) generated surface: EF entity / DbSet+AppDbContext /
// minimal-API routes / DataAnnotations validation / extractor / render helper /
// payload record / output-format prompt / output parser / filter allowlist / trace.
//
// NAMES on every symbol come from the CSharpNaming seam (never re-concatenated in the
// builder), so what this model documents == what the real generators emit.

namespace MetaObjects.Codegen.ApiDocs;

/// <summary>One documented symbol of the generated C# SDK surface.</summary>
/// <param name="Name">The emitted C# identifier (or "VERB path" for a REST endpoint).</param>
/// <param name="Kind">Which generated category this symbol belongs to.</param>
/// <param name="Namespace">The C# namespace the symbol lives in (e.g. <c>Acme.Shop</c>).</param>
/// <param name="Signature">A human-readable C# signature line.</param>
/// <param name="Usage">A one-line "what you use this for".</param>
/// <param name="Returns">The symbol's return surface, or null.</param>
/// <param name="Fields">Per-field shapes for record/validation symbols (may be empty).</param>
public sealed record ApiSymbol(
    string Name,
    ApiSymbolKind Kind,
    string Namespace,
    string Signature,
    string Usage,
    string? Returns = null,
    IReadOnlyList<FieldShape>? Fields = null)
{
    /// <summary>The field shapes carried by this symbol (never null at the read site).</summary>
    public IReadOnlyList<FieldShape> FieldList => Fields ?? Array.Empty<FieldShape>();
}

/// <summary>The generated-category axis a documented symbol belongs to (C# / EF Core flavored).</summary>
public enum ApiSymbolKind
{
    /// <summary>The EF Core entity class or value-object POCO.</summary>
    Model,
    /// <summary>Data access — the DbSet + AppDbContext surface.</summary>
    DataAccess,
    /// <summary>An ASP.NET Core minimal-API endpoint (named "VERB path").</summary>
    Rest,
    /// <summary>DataAnnotations validation on the entity create/update shape.</summary>
    Validation,
    /// <summary>The tolerant extractor for a template payload.</summary>
    Extractor,
    /// <summary>The typed render helper wrapping the render engine.</summary>
    Render,
    /// <summary>The typed payload record bound to a template.</summary>
    Payload,
    /// <summary>The output-format prompt fragment.</summary>
    Prompt,
    /// <summary>The output parser (Parse/TryParse) back into the typed payload.</summary>
    OutputParser,
    /// <summary>The per-entity sort/filter allowlist.</summary>
    Filter,
}

/// <summary>A documented field: name + C# type + optionality + an optional note (e.g. enum values).</summary>
public sealed record FieldShape(string Name, string Type, bool Optional, string? Note = null);

/// <summary>One documented unit (an entity / value object, or a template) + its symbols.</summary>
/// <param name="Node">The unit's short name (the doc-page basename).</param>
/// <param name="Package">The unit's metadata package (e.g. <c>acme::shop</c>).</param>
/// <param name="Kind">"entity" | "value" | "template".</param>
/// <param name="Symbols">The documented symbols, in canonical IR order.</param>
public sealed record ApiUnit(
    string Node,
    string Package,
    string Kind,
    IReadOnlyList<ApiSymbol> Symbols);

/// <summary>The full per-project C# SDK api surface IR.</summary>
public sealed record CSharpApiModel(string Project, IReadOnlyList<ApiUnit> Units);
