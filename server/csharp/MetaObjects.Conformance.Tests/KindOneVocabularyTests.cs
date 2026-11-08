// Ruling R40 kind 1: vocabulary only some ports implement so far is still cross-port
// vocabulary. The generic view.* controls (and view.textarea @rows / the view.image attrs)
// are implemented in TypeScript only; the JVM's @object in Java only. Both are in the shared
// registry and the manifest, marked `implementedIn`, and C# loads them strictly and ignores
// them. An attr the registry does not carry still fails.

using MetaObjects;
using MetaObjects.Loader;
using Xunit;

namespace MetaObjects.Conformance.Tests;

public sealed class KindOneVocabularyTests
{
    private const string Model = """
        { "metadata.root": { "package": "acme", "children": [
          { "object.entity": { "name": "Product", "@object": "com.acme.Product", "children": [
            { "source.rdb": { "@table": "products" } },
            { "field.long": { "name": "id" } },
            { "field.string": { "name": "notes", "children": [
              { "view.textarea": { "name": "form", "@rows": 6 } } ] } },
            { "field.string": { "name": "coverKey", "children": [
              { "view.image": { "name": "form", "@aspectRatio": 1.5, "@maxEdge": 2000, "@store": "photos",
                                "@accept": ["image/png"], "@maxBytes": 1048576 } } ] } },
            { "identity.primary": { "@fields": "id" } }
          ] } }
        ] } }
        """;

    private static LoadResult LoadStrict(string json) =>
        new MetaDataLoader(Provider.ComposeRegistry(CoreTypes.LibraryProviders), strict: true)
            .Load([new InMemoryStringSource(json, id: "meta.json")]);

    [Fact]
    public void A_strict_load_accepts_kind_one_views_and_object()
    {
        LoadResult result = LoadStrict(Model);
        Assert.Empty(result.Errors.Select(e => e.Code + ": " + e.Message));
        Assert.Equal("com.acme.Product", result.Root.Objects().Single().OwnAttr("object"));
    }

    [Fact]
    public void An_unregistered_attr_on_a_kind_one_view_still_fails()
    {
        string bad = Model.Replace("\"@maxBytes\": 1048576", "\"@cropShape\": \"circle\"");
        LoadResult result = LoadStrict(bad);
        Assert.Contains(result.Errors, e => e.Code.ToString() == "ERR_UNKNOWN_ATTR" && e.Message.Contains("cropShape"));
    }

    [Fact]
    public void The_manifest_carries_them_marked_implemented_in()
    {
        string manifest = RegistryManifest.Emit(Provider.ComposeRegistry(CoreTypes.LibraryProviders));
        Assert.Contains(
            "\"subType\": \"image\",\n      \"implementedIn\": [\n        \"typescript\"\n      ],\n      \"description\":",
            manifest.Replace("\r\n", "\n"));
        Assert.Contains(
            "\"name\": \"object\",\n          \"valueType\": \"string\",\n          \"isArray\": false,\n" +
            "          \"required\": false,\n          \"implementedIn\": [\n            \"java\"\n          ],",
            manifest.Replace("\r\n", "\n"));

        var registry = Provider.ComposeRegistry(CoreTypes.LibraryProviders);
        Assert.Equal(new[] { "typescript" }, registry.Find("view", "image")!.ImplementedIn);
        Assert.Contains(registry.Find("view", "image")!.Attributes, a => a.Name == "accept");
        Assert.Contains(registry.Find("view", "textarea")!.Attributes, a => a.Name == "rows");
        Assert.Empty(registry.Find("view", "currency")!.ImplementedIn);
        Assert.Equal(new[] { "java" }, registry.Find("object", "entity")!.Attributes.Single(a => a.Name == "object").ImplementedIn);
        Assert.Equal(new[] { "java", "kotlin" }, registry.Find("object", "entity")!.Attributes.Single(a => a.Name == "objectAdapter").Ports);
    }
}
