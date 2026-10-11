using System.Text.Json.Serialization;
using Xunit;

namespace MetaObjects.Render.Tests;

/// <summary>
/// A typed payload must render byte-identically to the equal map payload: <c>-last</c> and
/// <c>has&lt;Field&gt;</c> come from one mechanism, whatever the payload's shape. The oracle is
/// the shared render-list-separator fixture, whose expected.txt is shared by every port.
/// </summary>
public class TypedPayloadTests
{
    // Generated-POCO shape: PascalCase members carrying the metadata field name as a wire name.
    private sealed class WireItem { [JsonPropertyName("name")] public string Name { get; set; } = ""; }
    private sealed class WireTag { [JsonPropertyName("label")] public string Label { get; set; } = ""; }
    private sealed class WireGroup { [JsonPropertyName("tags")] public List<WireTag> Tags { get; set; } = new(); }
    private sealed class WireOwner { [JsonPropertyName("nick")] public string Nick { get; set; } = ""; }
    private sealed class WireEntry
    {
        [JsonPropertyName("name")] public string Name { get; set; } = "";
        [JsonPropertyName("note")] public string? Note { get; set; }
        [JsonPropertyName("owner")] public WireOwner Owner { get; set; } = new();
    }
    private sealed class WirePayload
    {
        [JsonPropertyName("items")] public List<WireItem> Items { get; set; } = new();
        [JsonPropertyName("solo")] public List<WireItem> Solo { get; set; } = new();
        [JsonPropertyName("none")] public List<WireItem> None { get; set; } = new();
        [JsonPropertyName("groups")] public List<WireGroup> Groups { get; set; } = new();
        [JsonPropertyName("entries")] public List<WireEntry> Entries { get; set; } = new();
        [JsonPropertyName("authored")] public List<Dictionary<string, object?>> Authored { get; set; } = new();
    }

    // Plain shape: members ARE the field names, no attributes.
    private sealed record PlainItem(string name);
    private sealed record PlainTag(string label);
    private sealed record PlainGroup(List<PlainTag> tags);
    private sealed record PlainOwner(string nick);
    private sealed record PlainEntry(string name, string? note, PlainOwner owner);
    private sealed record PlainPayload(
        List<PlainItem> items, List<PlainItem> solo, List<PlainItem> none,
        List<PlainGroup> groups, List<PlainEntry> entries, List<Dictionary<string, object?>> authored);

    private static string FixtureDir()
    {
        string root = AppContext.BaseDirectory;
        while (!Directory.Exists(Path.Combine(root, "fixtures", "render-conformance")))
            root = Directory.GetParent(root)?.FullName ?? throw new InvalidOperationException("fixtures not found");
        return Path.Combine(root, "fixtures", "render-conformance", "render-list-separator");
    }

    private static string Render(string template, object? payload) =>
        Renderer.Render(new RenderRequest { Template = template, Payload = payload, Format = "text", Provider = new InMemoryProvider(new Dictionary<string, string>()) });

    private static Dictionary<string, object?> Authored(string name) =>
        new() { ["name"] = name, ["-last"] = true };

    [Fact]
    public void WireNamedPayloadRendersTheSharedFixtureByteIdentically()
    {
        var payload = new WirePayload
        {
            Items = { new() { Name = "a" }, new() { Name = "b" }, new() { Name = "c" } },
            Solo = { new() { Name = "only" } },
            Groups =
            {
                new() { Tags = { new() { Label = "x" }, new() { Label = "y" } } },
                new() { Tags = { new() { Label = "z" } } },
            },
            Entries =
            {
                new() { Name = "a", Note = "x", Owner = new() { Nick = "ann" } },
                new() { Name = "b", Owner = new() { Nick = "bob" } },
                new() { Name = "c", Note = "z", Owner = new() { Nick = "cy" } },
            },
            Authored = { Authored("p"), Authored("q") },
        };
        var template = File.ReadAllText(Path.Combine(FixtureDir(), "template.mustache"));
        var expected = File.ReadAllText(Path.Combine(FixtureDir(), "expected.txt"));
        Assert.Equal(expected, Render(template, payload));
    }

    [Fact]
    public void PlainMemberPayloadRendersTheSharedFixtureByteIdentically()
    {
        var payload = new PlainPayload(
            [new("a"), new("b"), new("c")], [new("only")], [],
            [new([new("x"), new("y")]), new([new("z")])],
            [new("a", "x", new("ann")), new("b", null, new("bob")), new("c", "z", new("cy"))],
            [Authored("p"), Authored("q")]);
        var template = File.ReadAllText(Path.Combine(FixtureDir(), "template.mustache"));
        var expected = File.ReadAllText(Path.Combine(FixtureDir(), "expected.txt"));
        Assert.Equal(expected, Render(template, payload));
    }

    [Fact]
    public void HasFieldGateWorksOnTypedElementsLikeOnMaps()
    {
        const string template = "{{#items}}{{name}}:{{#hasNote}}y{{/hasNote}}{{^hasNote}}n{{/hasNote}} {{/items}}";
        var typed = new List<WireEntry>
        {
            new() { Name = "a", Note = "x" },
            new() { Name = "b", Note = " " },
        };
        var maps = new List<Dictionary<string, object?>>
        {
            new() { ["name"] = "a", ["note"] = "x" },
            new() { ["name"] = "b", ["note"] = " " },
        };
        var viaTyped = Render(template, new Dictionary<string, object?> { ["items"] = typed });
        var viaMaps = Render(template, new Dictionary<string, object?> { ["items"] = maps });
        Assert.Equal("a:y b:n ", viaMaps);
        Assert.Equal(viaMaps, viaTyped);
    }
}
