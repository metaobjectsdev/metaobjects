using System.IO;
using System.Linq;
using MetaObjects.Codegen;
using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

/// <summary>
/// Cross-port enum conformance (C#). Loads the shared fixture
/// <c>fixtures/codegen-conformance/enum/input/meta.enum.json</c> and asserts the entity
/// generator represents enum fields as C# <c>enum</c>s: an INLINE enum (<c>status</c>)
/// emits a nested <c>public enum &lt;Entity&gt;&lt;Field&gt;</c> in the entity file, while a
/// field that <c>extends</c> the abstract root <c>Priority</c> enum collapses onto one shared
/// <c>Enums.g.cs</c> declaration the entity references.
/// </summary>
public class EnumConformanceTests
{
    private static string LocateRepoRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, "fixtures")))
            dir = dir.Parent;
        Assert.NotNull(dir);
        return dir!.FullName;
    }

    private static string FixtureDir =>
        Path.Combine(LocateRepoRoot(), "fixtures", "codegen-conformance", "enum", "input");

    private static MetaRoot LoadFixture()
    {
        var load = MetaDataLoader.FromDirectory(FixtureDir);
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
    public void Inline_enum_field_emits_a_nested_enum_in_the_entity()
    {
        var files = new EntityGenerator().Generate(Context(LoadFixture())).ToList();
        var ticket = Assert.Single(files, f => f.Path == "Ticket.g.cs");
        Assert.Contains("public enum TicketStatus { OPEN, PENDING, CLOSED }", ticket.Content);
        Assert.Contains("public TicketStatus", ticket.Content);
    }

    [Fact]
    public void Extends_abstract_root_enum_is_materialized_once_in_shared_enums_file()
    {
        var files = new EntityGenerator().Generate(Context(LoadFixture())).ToList();
        var enums = Assert.Single(files, f => f.Path == "Enums.g.cs");
        Assert.Contains("public enum Priority { LOW, MEDIUM, HIGH }", enums.Content);

        // The entity references the shared enum without redeclaring it.
        var ticket = Assert.Single(files, f => f.Path == "Ticket.g.cs");
        Assert.DoesNotContain("public enum Priority", ticket.Content);
        Assert.Contains("public Priority", ticket.Content);
    }

    [Fact]
    public void Enum_columns_get_string_conversion_in_the_dbcontext()
    {
        var files = new DbContextGenerator().Generate(Context(LoadFixture())).ToList();
        var ctx = Assert.Single(files);
        // EF stores the enum as its string member name.
        Assert.Contains("HasConversion<string>()", ctx.Content);
    }
}
