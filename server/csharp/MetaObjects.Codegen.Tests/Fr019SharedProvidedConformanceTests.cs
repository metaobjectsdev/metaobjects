using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using MetaObjects.Codegen;
using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

/// <summary>
/// Cross-port FR-019 conformance (C#). Loads the shared fixture
/// <c>fixtures/codegen-conformance/shared-provided-enum/input/meta.json</c> and asserts the two
/// FR-019 behaviors (ADR-0026): shared materialization (<c>Priority</c> emitted ONCE, both
/// entities reference it) and <c>@provided</c> (<c>Currency</c> not materialized; referenced at
/// the configured namespace; a missing namespace is a codegen-time error).
/// </summary>
public class Fr019SharedProvidedConformanceTests
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
        var dir = Path.Combine(LocateRepoRoot(), "fixtures", "codegen-conformance", "shared-provided-enum", "input");
        var load = MetaDataLoader.FromDirectory(dir);
        Assert.Empty(load.Errors);
        return load.Root;
    }

    private static GenContext Ctx(MetaRoot root, string? providedNs = null) => new()
    {
        Entities = root.Objects(),
        Root = root,
        Config = new GenConfig { OutDir = "/tmp", Namespace = "Acme.Gen", ProvidedEnumNamespace = providedNs },
    };

    [Fact]
    public void Shared_abstract_enum_is_materialized_once_and_referenced_by_both_entities()
    {
        var files = new EntityGenerator().Generate(Ctx(LoadFixture(), providedNs: "Acme.External")).ToList();

        var enums = Assert.Single(files, f => f.Path == "Enums.g.cs");
        Assert.Contains("public enum Priority { LOW, MEDIUM, HIGH }", enums.Content);
        // Exactly one declaration across the whole output.
        var decls = files.Sum(f => Regex.Matches(f.Content, @"public enum Priority\b").Count);
        Assert.Equal(1, decls);

        foreach (var path in new[] { "Ticket.g.cs", "Order.g.cs" })
        {
            var ef = Assert.Single(files, f => f.Path == path);
            Assert.DoesNotContain("public enum Priority", ef.Content);
            Assert.Contains("public Priority? Priority", ef.Content);
        }
    }

    [Fact]
    public void Provided_enum_is_not_materialized_and_referenced_at_the_configured_namespace()
    {
        var files = new EntityGenerator().Generate(Ctx(LoadFixture(), providedNs: "Acme.External")).ToList();

        // Nothing emitted for the provided Currency type.
        Assert.All(files, f => Assert.DoesNotContain("public enum Currency", f.Content));

        var ticket = Assert.Single(files, f => f.Path == "Ticket.g.cs");
        Assert.Contains("public Acme.External.Currency? Currency", ticket.Content);
    }

    [Fact]
    public void Provided_enum_with_no_namespace_config_is_a_codegen_error_naming_the_enum()
    {
        var ex = Assert.ThrowsAny<System.Exception>(() =>
            new EntityGenerator().Generate(Ctx(LoadFixture(), providedNs: null)).ToList());
        Assert.Contains("Currency", ex.Message);
    }
}
