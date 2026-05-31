// Conformance for the abstract-entity codegen contract (mirrors codegen-ts
// commit 39f2df9f via the shared fixture):
//   1. Invariant — abstract entities NEVER produce instance/write artifacts
//      (no DbSet, no routes, no filter allowlist, no CREATE TABLE).
//   2. Shape knob — EmitAbstractShapes (default false) gates the standalone
//      `public abstract class` shape from the entity generator.
//
// Shared fixture: fixtures/codegen-conformance/abstract/input/meta.abstract.json
//   AbstractRecord (abstract, source "abstract_records") + BaseShape (abstract,
//   no source) + Widget (concrete, extends BaseShape, source "widgets").

using MetaObjects.Codegen;
using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public class AbstractConformanceTests
{
    // Walk upward from the test assembly to the repo root (contains a fixtures/ dir).
    private static string LocateRepoRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, "fixtures")))
            dir = dir.Parent;
        Assert.NotNull(dir);
        return dir!.FullName;
    }

    private static string FixtureDir =>
        Path.Combine(LocateRepoRoot(), "fixtures", "codegen-conformance", "abstract", "input");

    private static MetaRoot LoadFixture()
    {
        var load = MetaDataLoader.FromDirectory(FixtureDir);
        Assert.Empty(load.Errors);
        return load.Root;
    }

    private static GenContext Context(MetaRoot root, bool emitAbstractShapes = false) => new()
    {
        Entities = root.Objects(),
        Root = root,
        Config = new GenConfig
        {
            OutDir = "/tmp",
            Namespace = "Acme.Gen",
            EmitAbstractShapes = emitAbstractShapes,
        },
    };

    // ---- DbContext: no DbSet for abstract entities, DbSet for the concrete one ----

    [Fact]
    public void DbContext_omits_abstract_entities_and_includes_the_concrete_one()
    {
        var root = LoadFixture();
        var files = new DbContextGenerator().Generate(Context(root)).ToList();
        var ctx = Assert.Single(files);

        Assert.DoesNotContain("DbSet<AbstractRecord>", ctx.Content);
        Assert.DoesNotContain("DbSet<BaseShape>", ctx.Content);
        Assert.Contains("DbSet<Widget>", ctx.Content);
    }

    // ---- Routes: no route file for abstract entities, file for the concrete one ----

    [Fact]
    public void Routes_omits_abstract_entities_and_includes_the_concrete_one()
    {
        var root = LoadFixture();
        var paths = new RoutesGenerator().Generate(Context(root)).Select(f => f.Path).ToList();

        Assert.DoesNotContain("AbstractRecordRoutes.g.cs", paths);
        Assert.DoesNotContain("BaseShapeRoutes.g.cs", paths);
        Assert.Contains("WidgetRoutes.g.cs", paths);
    }

    // ---- FilterAllowlist: no allowlist for abstract entities, file for the concrete one ----

    [Fact]
    public void FilterAllowlist_omits_abstract_entities_and_includes_the_concrete_one()
    {
        var root = LoadFixture();
        var paths = new FilterAllowlistGenerator().Generate(Context(root)).Select(f => f.Path).ToList();

        Assert.DoesNotContain("AbstractRecordFilterAllowlist.g.cs", paths);
        Assert.DoesNotContain("BaseShapeFilterAllowlist.g.cs", paths);
        Assert.Contains("WidgetFilterAllowlist.g.cs", paths);
    }

    // (Schema DDL is now owned by the TypeScript toolchain — the C# port emits no
    // CREATE TABLE, so the abstract-entity "no DDL" invariant is asserted TS-side.)

    // ---- EmitAbstractShapes knob (entity generator) ----

    [Fact]
    public void EntityGenerator_with_knob_off_omits_abstract_shapes()
    {
        var root = LoadFixture();
        var paths = new EntityGenerator().Generate(Context(root, emitAbstractShapes: false))
            .Select(f => f.Path).ToList();

        Assert.DoesNotContain("AbstractRecord.g.cs", paths);
        Assert.DoesNotContain("BaseShape.g.cs", paths);
        Assert.Contains("Widget.g.cs", paths);
    }

    [Fact]
    public void EntityGenerator_with_knob_on_emits_standalone_abstract_class_without_table_attribute()
    {
        var root = LoadFixture();
        var files = new EntityGenerator().Generate(Context(root, emitAbstractShapes: true)).ToList();

        var abstractFile = Assert.Single(files, f => f.Path == "AbstractRecord.g.cs");
        Assert.Contains("public abstract class AbstractRecord", abstractFile.Content);
        Assert.DoesNotContain("[Table(", abstractFile.Content);
        Assert.DoesNotContain("[Key]", abstractFile.Content);
        Assert.DoesNotContain("[Column(", abstractFile.Content);

        Assert.Contains(files, f => f.Path == "BaseShape.g.cs");
        Assert.Contains(files, f => f.Path == "Widget.g.cs");
    }
}
