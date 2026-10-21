// DecimalGate — the typed decimal gate of the persistence corpus (ADR-0019 Amendment 1).
//
// A runner holds a decimal to the TYPE, not to the shape of its value: before a row is compared,
// every field the model declares decimal (an entity field, or a report field typed `decimal` in
// report-shapes.json) must be null or a decimal that normalizes to the canonical string
// ^-?(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$. A double or float (a "binary float") fails the scenario
// even when its printed value would happen to match. The check runs on the value the runtime
// produced, BEFORE the comparison canonicalizes anything.

using System.Text.Json;
using System.Text.RegularExpressions;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit.Sdk;
using static MetaObjects.Core.Field.FieldConstants;

namespace MetaObjects.IntegrationTests.Runner;

internal static partial class DecimalGate
{
    [GeneratedRegex(@"^-?(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$")]
    private static partial Regex Canonical();

    /// <summary>Entity (or report) short name to the names of its decimal fields, matched case-insensitively.</summary>
    private static readonly Lazy<IReadOnlyDictionary<string, HashSet<string>>> Declared = new(Load);

    private static IReadOnlyDictionary<string, HashSet<string>> Load()
    {
        var map = new Dictionary<string, HashSet<string>>(StringComparer.Ordinal);
        var loaded = MetaDataLoader.FromUris([new Uri(CorpusPaths.FitnessMetadataFile)]);
        if (loaded.Errors.Count > 0)
            throw new InvalidOperationException(
                "failed to load corpus metadata: " + string.Join("; ", loaded.Errors.Select(e => e.Message)));
        foreach (var obj in loaded.Root.Objects().Where(o => !o.IsReport()))
        {
            var names = obj.Fields().Where(f => f.SubType == FIELD_SUBTYPE_DECIMAL)
                .Select(f => f.Name).ToHashSet(StringComparer.OrdinalIgnoreCase);
            if (names.Count > 0) map[obj.Name] = names;
        }
        using var shapes = JsonDocument.Parse(File.ReadAllText(Path.Combine(CorpusPaths.Corpus, "report-shapes.json")));
        foreach (var report in shapes.RootElement.GetProperty("reports").EnumerateArray())
        {
            var fq = report.GetProperty("report").GetString()!;
            var name = fq[(fq.LastIndexOf("::", StringComparison.Ordinal) + 2)..];
            var names = report.GetProperty("fields").EnumerateArray()
                .Where(f => f.GetProperty("subType").GetString() == FIELD_SUBTYPE_DECIMAL)
                .Select(f => f.GetProperty("name").GetString()!)
                .ToHashSet(StringComparer.OrdinalIgnoreCase);
            if (names.Count > 0) map[name] = names;
        }
        return map;
    }

    /// <summary>Fail the scenario when a declared-decimal field of <paramref name="actual"/> is not a canonical decimal.</summary>
    public static void Check(string scenarioPath, QuerySpec spec, object? actual)
    {
        if (!Declared.Value.TryGetValue(spec.Entity, out var fields)) return;
        switch (actual)
        {
            case IReadOnlyDictionary<string, object?> row:
                CheckRow(scenarioPath, spec, fields, row);
                break;
            case IReadOnlyList<IReadOnlyDictionary<string, object?>> rows:
                foreach (var row in rows) CheckRow(scenarioPath, spec, fields, row);
                break;
        }
    }

    private static void CheckRow(string scenarioPath, QuerySpec spec, HashSet<string> fields,
        IReadOnlyDictionary<string, object?> row)
    {
        foreach (var (name, value) in row)
        {
            if (!fields.Contains(name) || value is null) continue;
            if (value is not decimal d)
                throw new XunitException(
                    $"{scenarioPath} / {spec.Name}: decimal arrived as a binary float: field '{name}' is " +
                    $"{value.GetType().Name} ({value}), not a decimal");
            var text = Normalization.NormalizeValue(d) as string;
            if (text is null || !Canonical().IsMatch(text))
                throw new XunitException(
                    $"{scenarioPath} / {spec.Name}: field '{name}' is not a canonical decimal string: '{text}'");
        }
    }
}
