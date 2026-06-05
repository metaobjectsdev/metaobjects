// EntityGeneratorExtensibilityTests — verifies the EntityGenerator extension
// points (open-closed, ADR-0002): the class is subclassable, the per-class emit
// methods are overridable, and the two finer-grained hooks (EmitClassHeader +
// EmitPropertyAttributes) let an adopter customize the class header and append
// per-property C# attributes WITHOUT touching the base default output.
//
// The base (unsubclassed) generator must remain byte-stable — the IntegrationFixture
// drift gate is the strong enforcer of that; these tests assert the override seams
// work and the base is unchanged for the same input.

using System.Text;
using MetaObjects.Codegen;
using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public class EntityGeneratorExtensibilityTests
{
    private const string Model = """
    { "metadata.root": { "package": "acme", "children": [
      { "object.entity": { "name": "Subscriber", "children": [
        { "source.rdb": { "@table": "subscribers" } },
        { "field.long":    { "name": "id" } },
        { "field.string":  { "name": "email", "@required": true, "@maxLength": 255 } },
        { "field.boolean": { "name": "subscribed" } },
        { "identity.primary": { "@fields": "id" } }
      ]}}
    ]}}
    """;

    private static MetaRoot Load()
    {
        var r = new MetaDataLoader().Load([new InMemoryStringSource(Model, id: "ext.json")]);
        Assert.Empty(r.Errors);
        return r.Root;
    }

    private static GenContext Ctx(MetaRoot root) => new()
    {
        Entities = root.Objects(), Root = root,
        Config = new GenConfig { OutDir = "/tmp", Namespace = "Acme.Generated" },
    };

    // An adopter subclass that emits `public partial class <name>` (+ a marker
    // interface) instead of the default class header.
    private sealed class PartialEntityGenerator : EntityGenerator
    {
        protected override void EmitClassHeader(
            StringBuilder sb, MetaObject entity, string className, bool isProjection,
            IReadOnlyList<string> pkFields, GenContext ctx)
        {
            if (!isProjection)
                sb.AppendLine($"[Table(\"{CSharpNaming.Table(entity)}\")]");
            sb.AppendLine($"public partial class {className} : IAdopterEntity");
        }
    }

    // An adopter subclass that appends a custom attribute on every property.
    private sealed class AttributedEntityGenerator : EntityGenerator
    {
        protected override void EmitPropertyAttributes(
            StringBuilder sb, MetaObject owner, MetaField field, GenContext ctx)
        {
            sb.AppendLine("    [Adopter]");
        }
    }

    [Fact]
    public void Subclass_can_override_class_header_to_emit_partial_class()
    {
        var ctx = Ctx(Load());
        var src = Assert.Single(new PartialEntityGenerator().Generate(ctx)).Content;

        Assert.Contains("public partial class Subscriber : IAdopterEntity", src);
        // The default `public class Subscriber` header must NOT appear.
        Assert.DoesNotContain("public class Subscriber\n", src);
    }

    [Fact]
    public void Subclass_can_override_property_attribute_hook_to_append_attributes()
    {
        var ctx = Ctx(Load());
        var src = Assert.Single(new AttributedEntityGenerator().Generate(ctx)).Content;

        // The custom attribute lands on the properties, immediately preceding them.
        Assert.Contains("[Adopter]", src);
        Assert.Contains("    [Adopter]\n    public long Id { get; set; }", src);
        Assert.Contains("    [Adopter]\n    public string Email { get; set; } = default!;", src);
    }

    [Fact]
    public void Base_generator_output_is_unchanged_by_the_extension_seams()
    {
        var ctx = Ctx(Load());
        var src = Assert.Single(new EntityGenerator().Generate(ctx)).Content;

        // Default header: a plain `public class`, no marker interface, no partial.
        Assert.Contains("public class Subscriber", src);
        Assert.DoesNotContain("partial", src);
        Assert.DoesNotContain("IAdopterEntity", src);
        // Default property hook is a no-op: no adopter attributes.
        Assert.DoesNotContain("[Adopter]", src);
    }
}
