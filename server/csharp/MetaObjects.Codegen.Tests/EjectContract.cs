// The shared eject contract, as this port reads it (ADR-0034 Amendment 8).
//
// fixtures/generator-registry-conformance/registry.json says, for every generator, whether
// an owned copy holds its emit ("eject": "full") or why it is exempt, and in its top-level
// "eject" block what an owned copy may still reference (the engine surface) and every place
// the contract does not hold yet ("pending"). EjectContractTests asserts the contract; this
// class only reads the file.

using System.Text.Json;
using System.Text.RegularExpressions;

namespace MetaObjects.Codegen.Tests;

internal static class EjectContract
{
    internal const string Port = "csharp";

    internal sealed record PendingEntry(string Generator, string Port, string Assertion, int Gap, IReadOnlyList<string>? Outside);

    internal static string ManifestPath() =>
        Path.Combine(CorpusPaths.RepoRoot(), "fixtures", "generator-registry-conformance", "registry.json");

    private static readonly Lazy<JsonDocument> Document =
        new(() => JsonDocument.Parse(File.ReadAllText(ManifestPath())));

    private static JsonElement Root => Document.Value.RootElement;

    private static JsonElement Eject => Root.GetProperty("eject");

    /// <summary>Every generator in the shared file, with its <c>eject</c> declaration.</summary>
    internal static IReadOnlyDictionary<string, JsonElement> Generators() =>
        Root.GetProperty("generators").EnumerateObject().ToDictionary(p => p.Name, p => p.Value, StringComparer.Ordinal);

    /// <summary>The generators the shared file expects this port to expose.</summary>
    internal static IReadOnlySet<string> PortSlice() =>
        Generators()
            .Where(g => g.Value.GetProperty("ports").EnumerateArray().Any(p => p.GetString() == Port))
            .Select(g => g.Key)
            .ToHashSet(StringComparer.Ordinal);

    internal static bool IsExempt(string name) =>
        Generators()[name].GetProperty("eject").ValueKind == JsonValueKind.Object;

    internal static IReadOnlyList<PendingEntry> AllPending() =>
        Eject.GetProperty("pending").EnumerateArray()
            .Select(p => new PendingEntry(
                p.GetProperty("generator").GetString()!,
                p.GetProperty("port").GetString()!,
                p.GetProperty("assertion").GetString()!,
                p.GetProperty("gap").GetInt32(),
                p.TryGetProperty("outside", out var outside)
                    ? outside.EnumerateArray().Select(o => o.GetString()!).ToList()
                    : null))
            .ToList();

    /// <summary>This port's pending entries for one assertion, by generator. A generator has
    /// one entry per gap: a depth entry's <c>Outside</c> lists the types that gap closes.</summary>
    internal static IReadOnlyDictionary<string, List<PendingEntry>> Pending(string assertion) =>
        AllPending()
            .Where(p => p.Port == Port && p.Assertion == assertion)
            .GroupBy(p => p.Generator, StringComparer.Ordinal)
            .ToDictionary(g => g.Key, g => g.ToList(), StringComparer.Ordinal);

    private static JsonElement Surface => Eject.GetProperty("engineSurface").GetProperty(Port);

    internal static IReadOnlyList<string> Engine() =>
        Surface.GetProperty("engine").EnumerateArray().Select(e => e.GetString()!).ToList();

    /// <summary><c>**</c> matches any run of characters, <c>*</c> one dotted segment.</summary>
    private static Regex Glob(string pattern) =>
        new("^" + string.Concat(Regex.Split(pattern, @"(\*\*|\*)").Select(part =>
            part == "**" ? ".*" : part == "*" ? "[^.]*" : Regex.Escape(part))) + "$");

    private static readonly Lazy<List<Regex>> Scope = new(() =>
        Surface.GetProperty("codegenPackages").EnumerateArray().Select(p => Glob(p.GetString()!)).ToList());

    private static readonly Lazy<List<Regex>> EnginePatterns = new(() => Engine().Select(Glob).ToList());

    /// <summary>True when <paramref name="typeName"/> writes output: inside the codegen
    /// namespaces, and not engine.</summary>
    internal static bool OutsideEngineSurface(string typeName) =>
        Scope.Value.Any(p => p.IsMatch(typeName)) && !EnginePatterns.Value.Any(p => p.IsMatch(typeName));
}
