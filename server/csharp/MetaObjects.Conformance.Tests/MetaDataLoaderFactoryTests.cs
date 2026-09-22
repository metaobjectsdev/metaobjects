using System.IO;
using MetaObjects.Loader;
using Xunit;

namespace MetaObjects.Conformance.Tests;

public class MetaDataLoaderFactoryTests
{
    [Fact]
    public void FromDirectory_LoadsAndReturnsRoot()
    {
        string dir = Path.Combine(Path.GetTempPath(), "fl_" + Path.GetRandomFileName());
        Directory.CreateDirectory(dir);
        try
        {
            File.WriteAllText(Path.Combine(dir, "meta.tiny.json"),
                "{\"metadata.root\":{\"package\":\"x\",\"children\":[]}}");
            var result = MetaDataLoader.FromDirectory(dir);
            Assert.Empty(result.Errors);
            Assert.NotNull(result.Root);
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public void FromString_LoadsInlineJson()
    {
        var result = MetaDataLoader.FromString(
            "{\"metadata.root\":{\"package\":\"x\",\"children\":[]}}",
            MetaDataFormat.Json);
        Assert.Empty(result.Errors);
    }

    // The production default registry must carry the documentation provider's common
    // attrs. It did not: CoreTypes.LibraryProviders omitted DocTypesProvider while every
    // conformance test composed FullCoreRegistry (which has it), so the corpora stayed green
    // while `dotnet meta verify` — which loads strict through the DEFAULT registry — rejected
    // @description on every node, including the shipped iam/ai libraries' own metadata.
    [Fact]
    public void FromDirectory_Strict_AcceptsCommonDocumentationAttrs()
    {
        string dir = Path.Combine(Path.GetTempPath(), "fl_" + Path.GetRandomFileName());
        Directory.CreateDirectory(dir);
        try
        {
            File.WriteAllText(Path.Combine(dir, "meta.doc.json"),
                "{\"metadata.root\":{\"package\":\"x\",\"children\":[" +
                "{\"object.value\":{\"name\":\"Thing\",\"@description\":\"A thing.\",\"@title\":\"Thing\"," +
                "\"children\":[{\"field.string\":{\"name\":\"label\",\"@description\":\"The label.\"}}]}}]}}");
            var result = MetaDataLoader.FromDirectory(dir, strict: true);
            Assert.Empty(result.Errors);
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    // The unit-test bundle and the production default must be ONE composition, or a test
    // passing proves nothing about what adopters load. Compared by provider id.
    [Fact]
    public void DefaultRegistry_ComposesTheSameProvidersAsTheUnitTestBundle()
    {
        Assert.Equal(
            FullCoreRegistry.Providers.Select(p => p.Id).OrderBy(id => id, StringComparer.Ordinal),
            CoreTypes.LibraryProviders.Select(p => p.Id).OrderBy(id => id, StringComparer.Ordinal));
    }
}
