// An entity may carry a derived (origin.*) field that only a projection reads, with no read
// source of its own: the shared fixture entity-derived-filter-gate (Member.hasActiveAgreement,
// an origin.first a projection's @filter reaches). Its table, the one `meta migrate` creates,
// has no column for that field. So the generated EF entity must declare no property for it and
// the DbContext must map none, or every EF query on Member names a column the table lacks.

using System.IO;
using System.Linq;
using MetaObjects.Codegen;
using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public class DerivedFieldWithoutReadSourceTests
{
    private static GenContext Context()
    {
        var dir = Path.Combine(CorpusPaths.RepoRoot(), "fixtures", "conformance", "entity-derived-filter-gate", "input");
        var load = MetaDataLoader.FromDirectory(dir);
        Assert.Empty(load.Errors);
        return new GenContext
        {
            Entities = load.Root.Objects(),
            Root = load.Root,
            Config = new GenConfig { OutDir = "/tmp", Namespace = "Acme.Gen" },
        };
    }

    [Fact]
    public void The_entity_declares_no_property_for_the_derived_field()
    {
        var member = Assert.Single(new EntityGenerator().Generate(Context()), f => f.Path == "Member.g.cs").Content;
        Assert.Contains("public long Id", member);
        Assert.DoesNotContain("HasActiveAgreement", member);
        Assert.DoesNotContain("has_active_agreement", member);
    }

    [Fact]
    public void The_DbContext_maps_no_column_for_the_derived_field()
    {
        var dbContext = Assert.Single(new DbContextGenerator().Generate(Context())).Content;
        Assert.Contains("Members", dbContext);
        Assert.DoesNotContain("HasActiveAgreement", dbContext);
        Assert.DoesNotContain("has_active_agreement", dbContext);
    }
}
