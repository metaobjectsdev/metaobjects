// An entity that `extends` another must carry the parent's properties.
//
// The member loop skips every field the C# base class supplies, so the class declaration has
// to NAME that base — and a base is only right when it cannot become an EF inheritance
// hierarchy. A concrete parent is a mapped entity with its own table; migrate-ts gives the
// child a table with ALL the columns, which `class Child : Parent` (TPH or TPT) would
// contradict, so the child is flattened. An abstract parent is an unmapped shape (emitted
// only with EmitAbstractShapes), so inheritance is exact there.

using MetaObjects.Codegen;
using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public class EntityExtendsParentTests
{
    private const string ConcreteParentModel = """
    { "metadata.root": { "package": "acme::demo", "children": [
      { "object.entity": { "name": "Parent", "children": [
        { "source.rdb": { "@table": "parents" } },
        { "field.long": { "name": "id" } },
        { "field.string": { "name": "title" } },
        { "identity.primary": { "name": "id", "@fields": "id", "@generation": "increment" } } ] } },
      { "object.entity": { "name": "Child", "extends": "Parent", "children": [
        { "source.rdb": { "@table": "children" } },
        { "field.string": { "name": "extra" } } ] } }
    ] } }
    """;

    private const string AbstractChainModel = """
    { "metadata.root": { "package": "acme::demo", "children": [
      { "object.entity": { "name": "Base", "abstract": true, "children": [
        { "field.long": { "name": "id" } } ] } },
      { "object.entity": { "name": "Audited", "abstract": true, "extends": "Base", "children": [
        { "field.timestamp": { "name": "createdAt" } } ] } },
      { "object.entity": { "name": "Widget", "extends": "Audited", "children": [
        { "source.rdb": { "@table": "widgets" } },
        { "field.string": { "name": "label" } },
        { "identity.primary": { "name": "id", "@fields": "id", "@generation": "increment" } } ] } }
    ] } }
    """;

    private static Dictionary<string, string> Generate(string model, bool abstractShapes)
    {
        var r = new MetaDataLoader().Load([new InMemoryStringSource(model, id: "extends.json")]);
        Assert.Empty(r.Errors);
        var ctx = new GenContext
        {
            Entities = r.Root.Objects(),
            Root = r.Root,
            Config = new GenConfig { OutDir = "/unused", Namespace = "Acme.Generated", EmitAbstractShapes = abstractShapes },
        };
        return new EntityGenerator().Generate(ctx).ToDictionary(f => f.Path, f => f.Content);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void A_child_of_a_concrete_parent_declares_the_parents_properties_and_names_no_base(bool abstractShapes)
    {
        var child = Generate(ConcreteParentModel, abstractShapes)["Child.g.cs"];
        // Not an EF inheritance hierarchy: Child owns its table and every column.
        Assert.Contains("public class Child", child);
        Assert.DoesNotContain("class Child :", child);
        Assert.Contains("public long Id { get; set; }", child);
        Assert.Contains(" Title { get; set; }", child);
        Assert.Contains(" Extra { get; set; }", child);
        Assert.Contains("[Table(\"children\")]", child);
        // The parent is untouched.
        var parent = Generate(ConcreteParentModel, abstractShapes)["Parent.g.cs"];
        Assert.DoesNotContain("Extra", parent);
    }

    [Fact]
    public void An_entity_extending_an_emitted_abstract_shape_names_it_and_declares_only_its_own_members()
    {
        var files = Generate(AbstractChainModel, abstractShapes: true);
        Assert.Contains("public abstract class Base", files["Base.g.cs"]);
        Assert.DoesNotContain("class Base :", files["Base.g.cs"]);
        var audited = files["Audited.g.cs"];
        Assert.Contains("public abstract class Audited : Base", audited);
        Assert.Contains("CreatedAt", audited);
        Assert.DoesNotContain(" Id ", audited);
        var widget = files["Widget.g.cs"];
        Assert.Contains("public class Widget : Audited", widget);
        Assert.Contains("Label", widget);
        // Inherited through the base chain, not restated.
        Assert.DoesNotContain("CreatedAt", widget);
        Assert.DoesNotContain(" Id ", widget);
    }

    [Fact]
    public void Without_emitted_shapes_an_abstract_parents_fields_are_flattened_onto_the_child()
    {
        var widget = Generate(AbstractChainModel, abstractShapes: false)["Widget.g.cs"];
        Assert.DoesNotContain("class Widget :", widget);
        Assert.Contains("public long Id { get; set; }", widget);
        Assert.Contains("CreatedAt", widget);
        Assert.Contains("Label", widget);
    }
}
