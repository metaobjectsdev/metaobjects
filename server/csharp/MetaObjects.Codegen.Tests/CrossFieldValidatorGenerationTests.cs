using System.ComponentModel.DataAnnotations;
using System.Reflection;
using System.Text.Json;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using MetaObjects.Codegen;
using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

/// <summary>Generator-level tests for entity-scoped cross-field validators on the full record model.</summary>
public class CrossFieldValidatorGenerationTests
{
    private const string Model = """
    { "metadata.root": { "package": "acme", "children": [
      { "object.entity": { "name": "Event", "children": [
        { "source.rdb": { "@table": "events" } },
        { "field.long":   { "name": "id" } },
        { "field.int":    { "name": "lo" } },
        { "field.int":    { "name": "hi" } },
        { "field.string": { "name": "email" } },
        { "field.string": { "name": "phone" } },
        { "identity.primary": { "@fields": "id" } },
        { "validator.comparison": { "name": "c", "@left": "lo", "@op": "lt", "@right": "hi" } },
        { "validator.atLeastOne": { "name": "r", "@fields": ["email", "phone"] } },
        { "validator.requiredWhen": { "name": "ghost", "@field": "email", "@when": "missing", "@equals": "x" } }
      ]}}
    ]}}
    """;

    private const string Plain = """
    { "metadata.root": { "package": "acme", "children": [
      { "object.entity": { "name": "Widget", "children": [
        { "source.rdb": { "@table": "widgets" } },
        { "field.long":   { "name": "id" } },
        { "field.string": { "name": "name" } },
        { "identity.primary": { "@fields": "id" } }
      ]}}
    ]}}
    """;

    private const string Inherited = """
    { "metadata.root": { "package": "acme", "children": [
      { "object.entity": { "name": "Parent", "children": [
        { "source.rdb": { "@table": "parents" } },
        { "field.long": { "name": "id" } },
        { "field.int": { "name": "a" } },
        { "field.int": { "name": "b" } },
        { "identity.primary": { "@fields": "id" } },
        { "validator.comparison": { "name": "ab", "@left": "a", "@op": "lte", "@right": "b" } }
      ]}},
      { "object.entity": { "name": "Child", "extends": "Parent", "children": [
        { "source.rdb": { "@table": "children" } },
        { "field.int": { "name": "c" } },
        { "field.int": { "name": "d" } },
        { "validator.comparison": { "name": "cd", "@left": "c", "@op": "lte", "@right": "d" } }
      ]}}
    ]}}
    """;

    private static GenContext Ctx(string model)
    {
        var r = new MetaDataLoader().Load([new InMemoryStringSource(model, id: "xf.json")]);
        Assert.Empty(r.Errors);
        return new GenContext
        {
            Entities = r.Root.Objects(), Root = r.Root,
            Config = new GenConfig { OutDir = "/tmp", Namespace = "Acme" },
        };
    }

    private static string Entity(string model, string name) =>
        new EntityGenerator().Generate(Ctx(model)).Single(f => f.Path == $"{name}.g.cs").Content;

    [Fact]
    public void Emits_IValidatableObject_with_each_rule()
    {
        var src = Entity(Model, "Event");
        Assert.Contains("public class Event : IValidatableObject", src);
        Assert.Contains("Lo is { } __l1 && Hi is { } __r1 && !(__l1 < __r1)", src);
        Assert.Contains("if (Email is null && Phone is null)", src);
        Assert.DoesNotContain("missing", src, StringComparison.OrdinalIgnoreCase); // unresolved ref skipped
    }

    [Fact]
    public void Entity_without_cross_field_validators_is_unchanged()
    {
        var src = Entity(Plain, "Widget");
        Assert.DoesNotContain("IValidatableObject", src);
        Assert.DoesNotContain("Validate(", src);
    }

    [Fact]
    public void Update_handlers_do_not_run_object_validation()
    {
        var routes = new RoutesGenerator().Generate(Ctx(Model)).Single().Content;
        var update = routes.Substring(routes.IndexOf("Task<IResult> UpdateEvent", StringComparison.Ordinal));
        update = update.Substring(0, update.IndexOf("app.MapPatch", StringComparison.Ordinal));
        Assert.DoesNotContain("TryValidateObject", update);
        Assert.DoesNotContain("Validate(", update);
        Assert.Contains("TryValidateObject", routes); // create still validates the object
    }

    [Fact]
    public void Derived_entity_overrides_and_chains_to_base()
    {
        var ctx = Ctx(Inherited);
        var files = new BasedEntityGenerator().Generate(ctx).ToList();
        var child = files.Single(f => f.Path == "Child.g.cs").Content;
        Assert.Contains("public override IEnumerable<ValidationResult> Validate", child);
        Assert.Contains("base.Validate(validationContext)", child);
        Assert.DoesNotContain("IValidatableObject", child);
        var parent = files.Single(f => f.Path == "Parent.g.cs").Content;
        Assert.Contains("public class Parent : IValidatableObject", parent);

        var trees = files.Select(f => CSharpSyntaxTree.ParseText(f.Content)).ToArray();
        var refs = ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!)
            .Split(Path.PathSeparator).Where(p => p.Length > 0)
            .Select(p => (MetadataReference)MetadataReference.CreateFromFile(p)).ToList();
        var comp = CSharpCompilation.Create("xfi_" + Guid.NewGuid().ToString("N"), trees, refs,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        using var ms = new MemoryStream();
        var emit = comp.Emit(ms);
        Assert.True(emit.Success, string.Join("; ", emit.Diagnostics.Where(d => d.Severity == DiagnosticSeverity.Error)));
        var asm = Assembly.Load(ms.ToArray());
        var t = asm.GetType("Acme.Child")!;
        object inst = JsonSerializer.Deserialize("{\"a\":3,\"b\":1,\"c\":1,\"d\":0}", t,
            new JsonSerializerOptions { PropertyNameCaseInsensitive = true })!;
        var results = new List<ValidationResult>();
        Assert.False(Validator.TryValidateObject(inst, new ValidationContext(inst), results, true));
        Assert.Equal(2, results.Count); // inherited rule AND the child's own rule
    }

    [Fact]
    public void Without_an_emitted_base_class_a_validator_on_an_unemitted_member_is_skipped()
    {
        // The stock mapped declaration names no C# base, so Child carries only its own fields;
        // the inherited rule references members it does not have and must be skipped, not emitted.
        var child = Entity(Inherited, "Child");
        Assert.Contains("public virtual IEnumerable<ValidationResult> Validate", child);
        Assert.DoesNotContain("A is {", child);
        Assert.Contains("C is { } __l", child);
    }

    // Emits the metadata `extends` chain as a C# base, the shape an adopter override produces.
    private sealed class BasedEntityGenerator : EntityGenerator
    {
        protected override void EmitClassDeclarationLine(
            System.Text.StringBuilder sb, MetaObject entity, string className, ClassDeclarationKind kind, GenContext ctx)
        {
            if (kind == ClassDeclarationKind.MappedEntity && DirectMappedParent(entity, ctx.Config) is { } p)
                sb.AppendLine($"public class {className} : {CSharpNaming.Pascal(p.Name)}");
            else
                base.EmitClassDeclarationLine(sb, entity, className, kind, ctx);
        }
    }
}
