// The REST collection segment and the DbSet name an object takes from its collection name: its own
// @collectionName, else the project's naming.collections pluralizer, else the rule every port has
// always served. fixtures/naming-conformance/collection-segments.json is shared with TypeScript.

using System.IO;
using System.Text.Json;
using MetaObjects.Codegen;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public class CollectionSegmentTests
{
    public sealed record SegmentCase(string Name, string? CollectionName, string? Pluralizer, string Segment)
    {
        public override string ToString() => $"{Name} (declared {CollectionName ?? "-"}, pluralizer {Pluralizer ?? "-"}) -> {Segment}";
    }

    public static TheoryData<SegmentCase> SegmentCases()
    {
        var path = Path.Combine(CorpusPaths.RepoRoot(), "fixtures", "naming-conformance", "collection-segments.json");
        using var doc = JsonDocument.Parse(File.ReadAllText(path));
        var data = new TheoryData<SegmentCase>();
        foreach (var c in doc.RootElement.GetProperty("cases").EnumerateArray())
        {
            data.Add(new SegmentCase(
                c.GetProperty("name").GetString()!,
                c.TryGetProperty("collectionName", out var d) ? d.GetString() : null,
                c.TryGetProperty("pluralizer", out var p) ? p.GetString() : null,
                c.GetProperty("segment").GetString()!));
        }
        return data;
    }

    private static MetaObject Entity(string name, string? collectionName, string? pluralizer)
    {
        var declared = collectionName is null ? "" : $@"""@collectionName"": ""{collectionName}"", ";
        var json = $@"{{ ""metadata.root"": {{ ""package"": ""acme"", ""children"": [
            {{ ""object.entity"": {{ ""name"": ""{name}"", {declared}""children"": [
                {{ ""source.rdb"": {{ ""@table"": ""t"" }} }},
                {{ ""field.long"": {{ ""name"": ""id"" }} }},
                {{ ""identity.primary"": {{ ""@fields"": ""id"" }} }}
            ] }} }}
        ] }} }}";
        var r = new MetaDataLoader().Load([new InMemoryStringSource(json, id: "segment.json")]);
        Assert.Empty(r.Errors);
        if (pluralizer is not null) r.Root.PhysicalNaming = PhysicalNaming.Default with { Collections = pluralizer };
        return r.Root.FindObject(name)!;
    }

    [Theory]
    [MemberData(nameof(SegmentCases))]
    public void RoutePath_matches_the_shared_corpus(SegmentCase c) =>
        Assert.Equal(c.Segment, CSharpNaming.RoutePath(Entity(c.Name, c.CollectionName, c.Pluralizer)));

    [Fact]
    public void DbSetName_takes_the_configured_pluralizer_and_a_declared_name_wins()
    {
        Assert.Equal("Analyses", CSharpNaming.DbSetName(Entity("Analysis", null, null)));
        Assert.Equal("Order", CSharpNaming.DbSetName(Entity("Order", null, "none")));
        Assert.Equal("Orders", CSharpNaming.DbSetName(Entity("Order", null, "standard")));
        Assert.Equal("FAQs", CSharpNaming.DbSetName(Entity("Faq", "FAQs", "none")));
        Assert.Equal("FindFAQsByOwner", CSharpNaming.ReverseFinderName(Entity("Faq", "FAQs", null), "ownerId"));
    }
}
