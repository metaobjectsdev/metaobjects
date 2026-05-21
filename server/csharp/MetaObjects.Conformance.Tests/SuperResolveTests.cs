using MetaObjects;
using MetaObjects.Loader;
using Xunit;

namespace MetaObjects.Conformance.Tests;

public class SuperResolveTests
{
    [Fact]
    public void Single_level_extends_resolves_and_inherits_fields()
    {
        var result = new FileMetaDataLoader().LoadDirectory(
            System.IO.Path.Combine(CorpusRoot.Path, "extends-single-level", "input"));
        Assert.Empty(result.Errors);
        // the subtype's effective fields include the base's fields (inherited via the resolved super chain)
        var sub = result.Root.OwnChildren().First(c => c.SuperData != null);
        Assert.True(sub.Children().Count > sub.OwnChildren().Count);
    }

    [Fact]
    public void Nonexistent_extends_collects_ERR_UNRESOLVED_SUPER()
    {
        var result = new FileMetaDataLoader().LoadDirectory(
            System.IO.Path.Combine(CorpusRoot.Path, "error-extends-nonexistent", "input"));
        Assert.Contains(result.Errors, e => e.Code == ErrorCode.ERR_UNRESOLVED_SUPER);
    }
}
