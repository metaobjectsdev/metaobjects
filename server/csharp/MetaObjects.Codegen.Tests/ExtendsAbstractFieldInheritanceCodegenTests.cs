using System.IO;
using System.Linq;
using MetaObjects.Codegen;
using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

/// <summary>
/// ADR-0039 (own-accessor discipline) — C# codegen honor-inheritance gate. Loads the
/// SHARED cross-port fixture <c>fixtures/conformance/extends-abstract-field-inheritance</c>
/// (an abstract array/decimal/object field + a BaseEntity, each extended by a concrete
/// node) and asserts the generated <c>Contact</c> entity + DbContext honor EVERY property
/// inherited via <c>extends</c>: array-ness (<c>isArray</c>), <c>@maxLength</c>,
/// <c>@precision</c>/<c>@scale</c>, <c>@objectRef</c>/<c>@storage</c>, and the BaseEntity
/// UUID primary key. Pre-fix (own-only reads) these silently dropped inherited values —
/// a scalar field, a default-precision decimal, an untyped object, and a missing PK.
/// </summary>
public class ExtendsAbstractFieldInheritanceCodegenTests
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
        var dir = Path.Combine(LocateRepoRoot(), "fixtures", "conformance",
            "extends-abstract-field-inheritance", "input");
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
    public void Generated_entity_honors_every_inherited_field_property()
    {
        var root = LoadFixture();
        var files = new EntityGenerator().Generate(Context(root)).ToList();

        // Abstract field bases + the abstract BaseEntity produce no entity file.
        Assert.DoesNotContain(files, f => f.Path == "BaseEntity.g.cs");

        var contact = Assert.Single(files, f => f.Path == "Contact.g.cs").Content;

        // BaseEntity PK (uuid id) inherited via extends -> [Key] on the Id property.
        Assert.Contains("[Key]", contact);
        Assert.Contains("public Guid Id", contact);
        // createdAt (timestamp) inherited from BaseEntity.
        Assert.Contains("CreatedAt", contact);

        // `tags` extends the abstract array field.string(isArray:true, @maxLength:40):
        // array-ness (ICollection, NOT a scalar string) must be inherited.
        Assert.Contains("ICollection<string> Tags", contact);
        Assert.DoesNotContain("public string Tags ", contact);

        // `addresses` extends field.object(isArray:true, @objectRef:Address, @storage:jsonb):
        // array-of-Address, honoring the inherited @objectRef + isArray.
        Assert.Contains("ICollection<Address> Addresses", contact);

        // `balance` extends field.decimal(@precision:12, @scale:2) -> decimal property.
        Assert.Contains("Balance", contact);
        Assert.Contains("decimal", contact);
    }

    [Fact]
    public void Generated_dbcontext_honors_inherited_decimal_precision()
    {
        var root = LoadFixture();
        var files = new DbContextGenerator().Generate(Context(root)).ToList();
        var dbContext = string.Join("\n", files.Select(f => f.Content));

        // @precision:12 / @scale:2 inherited from the abstract Money field must reach the
        // EF fluent mapping — pre-fix (own-only Precision/Scale) this .HasPrecision call
        // was absent (a default decimal(18,2) coercion), diverging from the schema DDL.
        Assert.Contains("HasPrecision(12, 2)", dbContext);
    }
}
