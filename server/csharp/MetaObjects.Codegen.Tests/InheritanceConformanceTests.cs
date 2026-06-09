using System.IO;
using System.Linq;
using MetaObjects.Codegen;
using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

/// <summary>
/// Cross-port inheritance conformance (C#). Loads the shared fixture
/// <c>fixtures/codegen-conformance/inheritance/input/meta.inheritance.json</c> and asserts the
/// flatten port inlines the FULL field set across two abstract levels into the concrete
/// <c>Product</c> entity — <c>Id</c>, <c>CreatedBy</c> (Base), <c>UpdatedBy</c> (Auditable) +
/// <c>Sku</c>, <c>QtyOnHand</c> (own) — while the abstract bases emit no entity file.
/// </summary>
public class InheritanceConformanceTests
{
    private static string LocateRepoRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, "fixtures")))
            dir = dir.Parent;
        Assert.NotNull(dir);
        return dir!.FullName;
    }

    private static MetaRoot LoadFixture()
    {
        var dir = Path.Combine(LocateRepoRoot(), "fixtures", "codegen-conformance", "inheritance", "input");
        var load = MetaDataLoader.FromDirectory(dir);
        Assert.Empty(load.Errors);
        return load.Root;
    }

    private static GenContext Context(MetaRoot root) => new()
    {
        Entities = root.Objects(),
        Root = root,
        Config = new GenConfig { OutDir = "/tmp", Namespace = "Acme.Gen" },
    };

    [Fact]
    public void Concrete_entity_flattens_the_full_multi_level_inherited_field_set()
    {
        var files = new EntityGenerator().Generate(Context(LoadFixture())).ToList();

        // Abstract bases produce no entity file (the abstract invariant).
        Assert.DoesNotContain(files, f => f.Path == "Base.g.cs");
        Assert.DoesNotContain(files, f => f.Path == "Auditable.g.cs");

        var product = Assert.Single(files, f => f.Path == "Product.g.cs");
        Assert.Contains("[Table(\"products\")]", product.Content);

        // All five fields present — 2 levels of inherited + 2 own.
        Assert.Contains("public long Id", product.Content);
        Assert.Contains("public string CreatedBy", product.Content);   // inherited from Base
        Assert.Contains("public string? UpdatedBy", product.Content);  // inherited from Auditable
        Assert.Contains("public string Sku", product.Content);
        Assert.Contains("public int? QtyOnHand", product.Content);

        // The inherited required + max-length constraints flatten too.
        Assert.Contains("[MaxLength(80)]", product.Content);
    }
}
