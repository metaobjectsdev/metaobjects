using MetaObjects;
using MetaObjects.Loader;
using Xunit;

namespace MetaObjects.Conformance.Tests;

public class LoaderTests
{
    private static string Corpus
    {
        get
        {
            string root = System.AppContext.BaseDirectory;
            while (!System.IO.Directory.Exists(System.IO.Path.Combine(root, "fixtures", "conformance")))
            {
                var parent = System.IO.Directory.GetParent(root)?.FullName;
                if (parent is null || parent == root)
                    throw new System.InvalidOperationException("fixtures/conformance not found");
                root = parent;
            }
            return System.IO.Path.Combine(root, "fixtures", "conformance");
        }
    }

    [Fact]
    public void Core_loader_consumes_MetaDataSource_units()
    {
        // The base pipeline takes sources directly — no filesystem knowledge.
        const string json = "{\"metadata.root\":{\"children\":[{\"object.entity\":{\"name\":\"W\"}}]}}";
        var src = new InMemoryStringSource(json, id: "inline.json");
        var result = new MetaDataLoader().Load([src]);
        Assert.Empty(result.Errors);
        Assert.NotNull(result.Root.OwnChildByName("W"));
    }

    [Fact]
    public void FileMetaDataLoader_discovers_and_merges_a_directory()
    {
        var loader = new FileMetaDataLoader();
        var result = loader.LoadDirectory(
            System.IO.Path.Combine(Corpus, "loader-basic-single-entity", "input"));
        Assert.Empty(result.Errors);
        Assert.Equal("loaded", loader.State);
    }

    [Fact]
    public void FileMetaDataLoader_directory_read_failure_collects_error_and_state_is_error()
    {
        var loader = new FileMetaDataLoader();
        var result = loader.LoadDirectory("/nonexistent/path/that/does/not/exist");
        Assert.NotEmpty(result.Errors);
        Assert.Equal("error", loader.State);
    }
}
