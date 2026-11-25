// The C# runner for fixtures/list-query-conformance/: every shared parse case (a query string in,
// the parsed list query or the exact 400 body out) through MetaObjects.AspNetCore's
// ListQueryParser, against the allowlist FilterAllowlistGenerator derives from the corpus's
// meta.json. The allowlist is derived, never written here, so a generator that derives a
// different one fails the same cases a parser bug would.

using System.Text.Json;
using System.Text.Json.Nodes;
using MetaObjects.AspNetCore;
using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public class ListQueryConformanceTests
{
    private static readonly string Dir =
        Path.Combine(CorpusPaths.RepoRoot(), "fixtures", "list-query-conformance");

    private sealed record Allowlist(
        IReadOnlyDictionary<string, FilterFieldRule> Rules,
        IReadOnlyDictionary<string, SortFieldRule> Sort,
        IReadOnlySet<string> FieldNames);

    private static readonly Lazy<Allowlist> Ticket = new(() =>
    {
        var result = new MetaDataLoader().Load([new FileSource(Path.Combine(Dir, "meta.json"))]);
        Assert.True(result.Errors.Count == 0, string.Join("; ", result.Errors.Select(e => e.ToString())));
        var entity = result.Root.Objects().Single(o => o.Name == "Ticket");
        var rules = new Dictionary<string, FilterFieldRule>(StringComparer.Ordinal);
        foreach (var (field, spec) in FilterAllowlistGenerator.FilterRules(entity, result.Root))
            rules[field] = new FilterFieldRule(Enum.Parse<FilterValueKind>(spec.Kind), spec.Ops.ToArray())
            {
                Format = spec.Format, Instant = spec.Instant, Integer = spec.Integer, EnumValues = spec.EnumValues,
            };
        var sort = new Dictionary<string, SortFieldRule>(StringComparer.Ordinal);
        foreach (var (field, order) in FilterAllowlistGenerator.SortRules(entity, result.Root)) sort[field] = new SortFieldRule(order);
        return new Allowlist(rules, sort, entity.Fields().Select(f => f.Name).ToHashSet(StringComparer.Ordinal));
    });

    public static IEnumerable<object[]> Cases()
    {
        using var doc = JsonDocument.Parse(File.ReadAllText(Path.Combine(Dir, "cases.json")));
        foreach (var c in doc.RootElement.GetProperty("cases").EnumerateArray())
            yield return new object[] { c.GetProperty("name").GetString()! };
    }

    [Theory]
    [MemberData(nameof(Cases))]
    public void Case_parses_as_the_corpus_says(string name)
    {
        var all = JsonNode.Parse(File.ReadAllText(Path.Combine(Dir, "cases.json")))!["cases"]!.AsArray();
        var c = all.Single(n => (string)n!["name"]! == name)!;
        var a = Ticket.Value;
        var result = ListQueryParser.Parse((string)c["query"]!, a.Rules, a.Sort, a.FieldNames);
        var actual = result.Ok ? new JsonObject { ["list"] = ToJson(result.Query!) } : new JsonObject { ["error"] = Reparse(result.Error!.Body()) };
        var expected = c["expect"]!;
        Assert.True(JsonNode.DeepEquals(expected, actual),
            $"{name} ({c["query"]}):\n  expected {expected.ToJsonString()}\n  actual   {actual.ToJsonString()}");
    }

    private static JsonNode Reparse(object value) => JsonNode.Parse(JsonSerializer.Serialize(value))!;

    private static JsonObject ToJson(ListQuery q)
    {
        var o = new JsonObject();
        if (q.Filter is not null) o["filter"] = Node(q.Filter);
        if (q.Search is not null) o["search"] = Reparse(new { term = q.Search.Term, fields = q.Search.Fields });
        if (q.Sort is not null) o["sort"] = Reparse(new { field = q.Sort.Field, order = q.Sort.Order });
        if (q.Limit is not null) o["limit"] = q.Limit;
        if (q.Offset is not null) o["offset"] = q.Offset;
        return o;
    }

    private static JsonNode Node(FilterNode node) => node switch
    {
        FilterLeaf l => new JsonObject { ["field"] = l.Field, ["op"] = l.Op, ["value"] = Reparse(l.Value) },
        FilterAnd and => new JsonObject { ["and"] = new JsonArray(and.Nodes.Select(Node).ToArray<JsonNode?>()) },
        FilterOr or => new JsonObject { ["or"] = new JsonArray(or.Nodes.Select(Node).ToArray<JsonNode?>()) },
        _ => throw new InvalidOperationException(node.GetType().Name),
    };
}
