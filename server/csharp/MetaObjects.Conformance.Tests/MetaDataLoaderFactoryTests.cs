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
}
