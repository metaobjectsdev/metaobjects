using System;
using System.IO;
using MetaObjects.Loader;
using Xunit;

namespace MetaObjects.Conformance.Tests;

public class UriSourceTests
{
    [Fact]
    public void FileScheme_ReadsLocalFile()
    {
        string path = Path.Combine(Path.GetTempPath(), "u_" + Path.GetRandomFileName() + ".json");
        File.WriteAllText(path, "{\"metadata.root\":{}}");
        try
        {
            var src = new UriSource(new Uri("file://" + path));
            Assert.Equal(MetaDataFormat.Json, src.Format);
            Assert.Equal("{\"metadata.root\":{}}", src.Read());
        }
        finally
        {
            File.Delete(path);
        }
    }

    [Fact]
    public void ExplicitFormat_OverridesExtensionInference()
    {
        string path = Path.Combine(Path.GetTempPath(), "u_" + Path.GetRandomFileName() + ".txt");
        File.WriteAllText(path, "metadata.root: {}");
        try
        {
            var src = new UriSource(new Uri("file://" + path), MetaDataFormat.Yaml);
            Assert.Equal(MetaDataFormat.Yaml, src.Format);
        }
        finally
        {
            File.Delete(path);
        }
    }
}
