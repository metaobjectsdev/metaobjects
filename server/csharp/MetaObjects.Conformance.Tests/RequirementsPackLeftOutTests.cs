using MetaObjects.Core.Requirement;
using MetaObjects.Loader;
using Xunit;

namespace MetaObjects.Conformance.Tests;

/// <summary>
/// The requirements vocabulary is its own pack (<c>metaobjects-requirements</c>), composed by default.
/// With the pack left out the gate has nothing to read and reports nothing, and a model that declares a
/// requirement fails to load instead.
/// </summary>
public class RequirementsPackLeftOutTests
{
    private const string Order = """
        - object.entity:
            name: Order
            children:
              - source.rdb: { table: orders }
              - field.long: { name: id }
              - identity.primary: { name: pk, fields: [id] }
        """;

    private const string Requirement = """
        - requirement.functional:
            name: PlaceOrder
            level: 4
            status: live
            statement: A customer places an order
            counterexample: A customer cannot place an order
            implementedBy: [app::Order]
        """;

    private static string Indent(string block) =>
        string.Join("\n", block.Split('\n').Select(l => "    " + l));

    private static LoadResult Load(TypeRegistry registry, params string[] blocks)
    {
        var dir = Directory.CreateTempSubdirectory("mo-req-left-out-").FullName;
        try
        {
            File.WriteAllText(Path.Combine(dir, "meta.app.yaml"),
                "metadata:\n  package: app\n  children:\n" + string.Join("\n", blocks.Select(Indent)) + "\n");
            return MetaDataLoader.FromDirectory(dir, registry, strict: true);
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    private static TypeRegistry WithoutPack() =>
        Provider.ComposeRegistry(CoreTypes.LibraryProviders.Where(p => p.Id != RequirementsMetaDataProvider.ProviderId).ToList());

    [Fact]
    public void A_model_with_no_requirements_loads_and_the_gate_reports_nothing()
    {
        var result = Load(WithoutPack(), Order);
        Assert.Empty(result.Errors.Select(e => e.Code + ": " + e.Message));
        var scan = RequirementCheck.Scan(result.Root);
        Assert.Empty(RequirementCheck.Check(result.Root, scan));
        Assert.Null(RequirementCheck.Summarise(result.Root, scan));
    }

    [Fact]
    public void A_model_that_declares_a_requirement_fails_to_load_with_ERR_UNKNOWN_TYPE()
    {
        var result = Load(WithoutPack(), Order, Requirement);
        Assert.Contains(result.Errors, e => e.Code == ErrorCode.ERR_UNKNOWN_TYPE);
    }

    [Fact]
    public void With_the_default_bundle_the_same_requirement_reaches_the_ledger()
    {
        var result = Load(Provider.ComposeRegistry(CoreTypes.LibraryProviders), Order, Requirement);
        Assert.Empty(result.Errors.Select(e => e.Code + ": " + e.Message));
        Assert.Equal(1, RequirementCheck.Summarise(result.Root, RequirementCheck.Scan(result.Root))?.Total);
    }
}
