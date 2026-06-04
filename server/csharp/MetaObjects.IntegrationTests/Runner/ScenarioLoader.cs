// ScenarioLoader — parse a fixture YAML into a typed Scenario record.
//
//   fixtures/persistence-conformance/queries/*.yaml     → QueryScenario
//
// Relative metadata paths in YAML resolve against the scenario file's directory.

using YamlDotNet.Core;
using YamlDotNet.RepresentationModel;
using YamlDotNet.Serialization;
using YamlDotNet.Serialization.NamingConventions;

namespace MetaObjects.IntegrationTests.Runner;

public static class ScenarioLoader
{
    // The `expect:` block is captured as a raw YamlNode (not a typed object graph)
    // so the comparison side can honor the YAML scalar STYLE: a plain (unquoted)
    // `45` is a JSON number, a quoted `"45"` is a JSON string. YamlDotNet's default
    // object-graph deserialization collapses both to the string "45", which would
    // make every INTEGER-typed expectation (durationMinutes, min/max aggregates)
    // un-representable. This matches the TS authority, whose JS YAML loader infers
    // scalar types the same way. See QueryScenarioRunner.YamlExpectToJsonNode.
    private static readonly IDeserializer Yaml = new DeserializerBuilder()
        .WithNamingConvention(HyphenatedNamingConvention.Instance)
        .WithTypeConverter(new YamlNodeTypeConverter())
        .Build();

    // Captures a YAML subtree verbatim (preserving scalar style) into a YamlNode,
    // so a property typed as YamlNode? receives the raw representation. Builds the
    // node graph by streaming events from the parser (YamlDotNet 18 has no public
    // IParser→YamlNode bridge), consuming exactly one node subtree.
    private sealed class YamlNodeTypeConverter : IYamlTypeConverter
    {
        public bool Accepts(Type type) => typeof(YamlNode).IsAssignableFrom(type);

        public object? ReadYaml(IParser parser, Type type, ObjectDeserializer rootDeserializer) =>
            BuildNode(parser);

        public void WriteYaml(IEmitter emitter, object? value, Type type, ObjectSerializer serializer) =>
            throw new NotSupportedException("YamlNode serialization is not used in scenario loading.");

        private static YamlNode BuildNode(IParser parser)
        {
            if (parser.TryConsume<YamlDotNet.Core.Events.Scalar>(out var scalar))
                return new YamlScalarNode(scalar.Value) { Style = scalar.Style };

            if (parser.TryConsume<YamlDotNet.Core.Events.SequenceStart>(out _))
            {
                var seq = new YamlSequenceNode();
                while (!parser.TryConsume<YamlDotNet.Core.Events.SequenceEnd>(out _))
                    seq.Add(BuildNode(parser));
                return seq;
            }

            if (parser.TryConsume<YamlDotNet.Core.Events.MappingStart>(out _))
            {
                var map = new YamlMappingNode();
                while (!parser.TryConsume<YamlDotNet.Core.Events.MappingEnd>(out _))
                {
                    var key = BuildNode(parser);
                    var value = BuildNode(parser);
                    map.Add(key, value);
                }
                return map;
            }

            throw new InvalidOperationException(
                $"unexpected YAML event while reading an expect subtree: {parser.Current?.GetType().Name ?? "null"}");
        }
    }

    /// <summary>Load every <c>*.yaml</c> in a directory as query scenarios.</summary>
    public static IReadOnlyList<QueryScenario> LoadQueries(string dir) =>
        Directory.EnumerateFiles(dir, "*.yaml", SearchOption.TopDirectoryOnly)
            .OrderBy(p => p, StringComparer.Ordinal)
            .Select(LoadQuery)
            .ToList();

    public static QueryScenario LoadQuery(string yamlPath)
    {
        var raw = Yaml.Deserialize<QueryYaml>(File.ReadAllText(yamlPath));
        return new QueryScenario(
            Name: raw.Name ?? throw new InvalidOperationException($"{yamlPath}: missing 'name'"),
            Description: raw.Description ?? "",
            SourcePath: yamlPath,
            SeedData: raw.SeedData,
            Queries: (raw.Queries ?? []).Select(q => new QuerySpec(
                Name: q.Name ?? throw new InvalidOperationException($"{yamlPath}: query missing 'name'"),
                Op: q.Op ?? throw new InvalidOperationException($"{yamlPath}: query missing 'op'"),
                Entity: q.Entity ?? throw new InvalidOperationException($"{yamlPath}: query missing 'entity'"),
                By: q.By,
                Filter: q.Filter,
                Sort: q.Sort?.Select(s => new SortSpec(s.Field ?? "", s.Dir ?? "asc")).ToList(),
                Limit: q.Limit,
                Offset: q.Offset,
                Relation: q.Relation,
                Data: q.Data,
                ExpectError: q.ExpectError ?? false,
                Insert: q.Insert,
                Expect: q.Expect)).ToList());
    }

    // ---------- YAML wire shapes (lower-cased + hyphenated via the naming convention) ----------

    private sealed class QueryYaml
    {
        public string? Name { get; set; }
        public string? Description { get; set; }
        public string? SeedData { get; set; }
        public List<QuerySpecYaml>? Queries { get; set; }
    }

    private sealed class QuerySpecYaml
    {
        public string? Name { get; set; }
        // A per-query `description:` is documentation only (used by some relate
        // scenarios to annotate the union-on-read direction); captured but unused.
        public string? Description { get; set; }
        public string? Op { get; set; }
        public string? Entity { get; set; }
        public Dictionary<string, object?>? By { get; set; }
        public Dictionary<string, object?>? Filter { get; set; }
        public List<SortYaml>? Sort { get; set; }
        public int? Limit { get; set; }
        public int? Offset { get; set; }
        public string? Relation { get; set; }
        // For op: create / update — the field values to write through the EF runtime.
        // Captured as a raw YamlNode (scalar style preserved) so the writer can honor
        // the authoring forms (a quoted full-int64/decimal/uuid stays a string; a
        // temporal string carries its Kind; a nested object is a mapping → owned POCO).
        // Same rationale as Insert — UPDATE re-encode of every subtype is the point of
        // update-delete-all-types.yaml, so it must use the same coercion as roundtrip.
        public YamlNode? Data { get; set; }
        // The corpus authors this key in camelCase (`expectError:`) while most other
        // keys are hyphenated (`seed-data:`); the hyphenated naming convention would
        // map it to `expect-error`, so pin the literal camelCase alias the fixtures use.
        [YamlMember(Alias = "expectError", ApplyNamingConventions = false)]
        public bool? ExpectError { get; set; }
        // For op: roundtrip — the field-keyed row to WRITE through the EF runtime.
        // Captured as a raw YamlNode (scalar style preserved) so the writer can honor
        // the authoring forms (a quoted decimal/uuid stays a string; a nested object is
        // a mapping). Mirrors the Expect capture rationale above.
        public YamlNode? Insert { get; set; }
        public YamlNode? Expect { get; set; }
    }

    private sealed class SortYaml
    {
        public string? Field { get; set; }
        public string? Dir { get; set; }
    }
}
