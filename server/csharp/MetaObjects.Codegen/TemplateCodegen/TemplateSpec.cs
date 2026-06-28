using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using MetaObjects.Codegen.Generators;
using MetaObjects.Render;

namespace MetaObjects.Codegen.TemplateCodegen;

/// <summary>One declarative template-generator spec entry (SP-1 §4 cross-port contract).</summary>
public sealed record TemplateSpecEntry(
    string Name, string Template, string Scope, string OutputPattern, string? Format);

/// <summary>
/// The declarative JSON template-spec the CLI ports (C#/Python) consume. The JSON
/// shape is the cross-port contract; a JSON Schema sits beside the TS port. This
/// class validates it and maps it to runnable <see cref="IGenerator"/>s.
/// </summary>
public static class TemplateSpec
{
    private static readonly HashSet<string> ValidFormats = new(StringComparer.Ordinal)
    {
        Escapers.FORMAT_TEXT, Escapers.FORMAT_HTML, Escapers.FORMAT_XML, Escapers.FORMAT_CSV,
        Escapers.FORMAT_JSON, Escapers.FORMAT_MARKDOWN, Escapers.FORMAT_SPREADSHEET,
    };

    private static string ReqStr(JsonElement entry, int i, string key)
    {
        if (!entry.TryGetProperty(key, out var v) || v.ValueKind != JsonValueKind.String
            || v.GetString() is not { Length: > 0 } s)
            throw new ArgumentException($"template-spec generators[{i}]: missing or empty required string '{key}'");
        return s;
    }

    public static IReadOnlyList<TemplateSpecEntry> Parse(JsonElement root)
    {
        if (root.ValueKind != JsonValueKind.Object
            || !root.TryGetProperty("generators", out var gens)
            || gens.ValueKind != JsonValueKind.Array)
            throw new ArgumentException("template-spec: expected an object with a `generators` array");

        var entries = new List<TemplateSpecEntry>();
        var i = 0;
        foreach (var entry in gens.EnumerateArray())
        {
            if (entry.ValueKind != JsonValueKind.Object)
                throw new ArgumentException($"template-spec generators[{i}]: expected an object");
            var name = ReqStr(entry, i, "name");
            var template = ReqStr(entry, i, "template");
            var scope = ReqStr(entry, i, "scope");
            var outputPattern = ReqStr(entry, i, "outputPattern");
            if (!ScopeWalk.Scopes.Contains(scope))
                throw new ArgumentException(
                    $"template-spec generators[{i}]: scope must be one of {string.Join(" | ", ScopeWalk.Scopes)}, got '{scope}'");

            string? format = null;
            if (entry.TryGetProperty("format", out var f) && f.ValueKind == JsonValueKind.String)
            {
                format = f.GetString();
                if (!ValidFormats.Contains(format!))
                    throw new ArgumentException(
                        $"template-spec generators[{i}]: format must be one of {string.Join(" | ", ValidFormats)}, got '{format}'");
            }

            // `target` (output routing) is not supported by the C# port — EmittedFile.Path is
            // relative to a single out dir. Reject it loudly so the cross-port divergence is
            // explicit rather than a silent layout difference vs TS.
            if (entry.TryGetProperty("target", out _))
                throw new ArgumentException(
                    $"template-spec generators[{i}]: `target` is not supported by the C# port (it has no output-target concept; output is relative to a single out dir)");

            entries.Add(new TemplateSpecEntry(name, template, scope, outputPattern, format));
            i++;
        }
        return entries;
    }

    public static IReadOnlyList<IGenerator> ToGenerators(IReadOnlyList<TemplateSpecEntry> spec, IProvider provider) =>
        spec.Select(e => TemplateGenerator.Create(
            e.Name, e.Template, ScopeWalk.ForScope(e.Scope, e.OutputPattern), provider, e.Format ?? Escapers.FORMAT_TEXT))
            .ToList();
}
