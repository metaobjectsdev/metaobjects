using System;
using System.IO;
using System.Linq;
using MetaObjects.Loader;
using Xunit;

namespace MetaObjects.Conformance.Tests;

public class DirectorySourceTests
{
    [Fact]
    public void Expand_ReturnsFileSourcesSortedByOrdinalName()
    {
        string dir = Path.Combine(Path.GetTempPath(), "ds_" + Path.GetRandomFileName());
        Directory.CreateDirectory(dir);
        try
        {
            File.WriteAllText(Path.Combine(dir, "b.json"), "{}");
            File.WriteAllText(Path.Combine(dir, "a.yaml"), "");
            File.WriteAllText(Path.Combine(dir, "ignored.txt"), "x");

            var src = new DirectorySource(dir);
            var expanded = src.Expand().ToList();

            Assert.Equal(2, expanded.Count);
            Assert.Equal("a.yaml", expanded[0].Id);
            Assert.Equal(MetaDataFormat.Yaml, expanded[0].Format);
            Assert.Equal("b.json", expanded[1].Id);
            Assert.Equal(MetaDataFormat.Json, expanded[1].Format);
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public void Expand_HonorsExcludeGlobs()
    {
        string dir = Path.Combine(Path.GetTempPath(), "ds_" + Path.GetRandomFileName());
        Directory.CreateDirectory(dir);
        try
        {
            File.WriteAllText(Path.Combine(dir, "meta.alpha.json"), "{}");
            File.WriteAllText(Path.Combine(dir, "meta.beta.json"), "{}");

            var src = new DirectorySource(dir, new DirectorySource.Options
            {
                Exclude = new[] { "meta.beta.json" },
            });
            var expanded = src.Expand().ToList();

            Assert.Single(expanded);
            Assert.Equal("meta.alpha.json", expanded[0].Id);
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }
}
