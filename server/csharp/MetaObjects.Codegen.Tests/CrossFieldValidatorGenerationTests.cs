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

/// <summary>
/// Generator-level tests for entity-scoped cross-field validators on the full record model: each
/// compiles the generated classes with Roslyn and runs <see cref="Validator.TryValidateObject(object, ValidationContext, ICollection{ValidationResult}, bool)"/>.
/// Oracle: the validators' declared meaning (FR-036's CHECK semantics), e.g. <c>lo lt hi</c>
/// rejects 2 &gt;= 1. The shared corpus gates the full verdict table; these cover inheritance and
/// the skipped-validator cases the corpus does not.
/// </summary>
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

    // The parent's only cross-field validator compares an int with a string, which no port emits,
    // so the parent class has nothing to evaluate; the child still declares a rule of its own.
    private const string SkippedParent = """
    { "metadata.root": { "package": "acme", "children": [
      { "object.entity": { "name": "Parent", "children": [
        { "source.rdb": { "@table": "parents" } },
        { "field.long": { "name": "id" } },
        { "field.int": { "name": "a" } },
        { "field.string": { "name": "b" } },
        { "identity.primary": { "@fields": "id" } },
        { "validator.comparison": { "name": "ab", "@left": "a", "@op": "lt", "@right": "b" } }
      ]}},
      { "object.entity": { "name": "Child", "extends": "Parent", "children": [
        { "source.rdb": { "@table": "children" } },
        { "field.string": { "name": "kind" } },
        { "field.string": { "name": "note" } },
        { "validator.requiredWhen": { "name": "kn", "@field": "note", "@when": "kind", "@equals": "X" } }
      ]}}
    ]}}
    """;

    // TPH: the abstract intermediate level is not emitted (EmitAbstractShapes off), so its rule
    // must still be evaluated by the concrete subtype that extends the emitted base.
    private const string TphAbstractMid = """
    { "metadata.root": { "package": "acme", "children": [
      { "object.entity": { "name": "Animal", "@discriminator": "type", "children": [
        { "source.rdb": { "@table": "animals" } },
        { "field.long": { "name": "id" } },
        { "field.string": { "name": "type" } },
        { "field.int": { "name": "lo" } },
        { "field.int": { "name": "hi" } },
        { "identity.primary": { "@fields": "id" } },
        { "validator.comparison": { "name": "lohi", "@left": "lo", "@op": "lte", "@right": "hi" } }
      ]}},
      { "object.entity": { "name": "Mammal", "extends": "Animal", "abstract": true, "children": [
        { "field.string": { "name": "kind" } },
        { "field.string": { "name": "fur" } },
        { "validator.requiredWhen": { "name": "furry", "@field": "fur", "@when": "kind", "@equals": "FURRY" } }
      ]}},
      { "object.entity": { "name": "Dog", "extends": "Mammal", "@discriminatorValue": "Dog", "children": [
        { "field.string": { "name": "bark" } }
      ]}}
    ]}}
    """;

    // A decimal compared with a double: C# has no implicit conversion between the two.
    private const string MixedNumeric = """
    { "metadata.root": { "package": "acme", "children": [
      { "object.entity": { "name": "Quote", "children": [
        { "source.rdb": { "@table": "quotes" } },
        { "field.long": { "name": "id" } },
        { "field.decimal": { "name": "price", "@precision": 10, "@scale": 2 } },
        { "field.double": { "name": "cap" } },
        { "identity.primary": { "@fields": "id" } },
        { "validator.comparison": { "name": "underCap", "@left": "price", "@op": "lte", "@right": "cap" } }
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

    private static Assembly Compile(EntityGenerator generator, string model)
    {
        var trees = generator.Generate(Ctx(model)).Select(f => CSharpSyntaxTree.ParseText(f.Content)).ToArray();
        var refs = ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!)
            .Split(Path.PathSeparator).Where(p => p.Length > 0)
            .Select(p => (MetadataReference)MetadataReference.CreateFromFile(p)).ToList();
        var comp = CSharpCompilation.Create("xfi_" + Guid.NewGuid().ToString("N"), trees, refs,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        using var ms = new MemoryStream();
        var emit = comp.Emit(ms);
        Assert.True(emit.Success, string.Join("; ", emit.Diagnostics.Where(d => d.Severity == DiagnosticSeverity.Error)));
        return Assembly.Load(ms.ToArray());
    }

    private static List<ValidationResult> Validate(Assembly asm, string type, string json)
    {
        object inst = JsonSerializer.Deserialize(json, asm.GetType($"Acme.{type}")!,
            new JsonSerializerOptions { PropertyNameCaseInsensitive = true })!;
        var results = new List<ValidationResult>();
        Validator.TryValidateObject(inst, new ValidationContext(inst), results, true);
        return results;
    }

    [Fact]
    public void Each_resolvable_rule_is_enforced_and_a_rule_on_a_missing_field_is_skipped()
    {
        var asm = Compile(new EntityGenerator(), Model);
        Assert.Empty(Validate(asm, "Event", "{\"lo\":1,\"hi\":2,\"email\":\"e\"}"));
        Assert.Single(Validate(asm, "Event", "{\"lo\":2,\"hi\":1,\"email\":\"e\"}"));
        Assert.Single(Validate(asm, "Event", "{\"lo\":1,\"hi\":2}"));
    }

    [Fact]
    public void A_decimal_compared_with_a_double_compiles_and_is_enforced()
    {
        var asm = Compile(new EntityGenerator(), MixedNumeric);
        Assert.Single(Validate(asm, "Quote", "{\"price\":5.5,\"cap\":3}"));
        Assert.Empty(Validate(asm, "Quote", "{\"price\":2.5,\"cap\":3}"));
    }

    [Fact]
    public void Entity_without_cross_field_validators_is_not_validatable()
    {
        var asm = Compile(new EntityGenerator(), Plain);
        Assert.False(typeof(IValidatableObject).IsAssignableFrom(asm.GetType("Acme.Widget")!));
    }

    [Fact]
    public void Derived_entity_runs_the_inherited_rule_and_its_own()
    {
        var asm = Compile(new BasedEntityGenerator(), Inherited);
        Assert.Equal(2, Validate(asm, "Child", "{\"a\":3,\"b\":1,\"c\":1,\"d\":0}").Count);
    }

    [Fact]
    public void Without_an_emitted_base_class_a_validator_on_an_unemitted_member_is_skipped()
    {
        // The stock mapped declaration names no C# base, so Child carries only its own fields;
        // the inherited rule references members it does not have and is skipped.
        var asm = Compile(new EntityGenerator(), Inherited);
        Assert.Single(Validate(asm, "Child", "{\"a\":3,\"b\":1,\"c\":1,\"d\":0}"));
    }

    [Fact]
    public void Derived_entity_compiles_when_every_base_rule_is_skipped()
    {
        var asm = Compile(new BasedEntityGenerator(), SkippedParent);
        Assert.Single(Validate(asm, "Child", "{\"kind\":\"X\"}"));
        Assert.Empty(Validate(asm, "Child", "{\"kind\":\"X\",\"note\":\"n\"}"));
    }

    [Fact]
    public void Tph_subtype_runs_the_rule_of_an_unemitted_abstract_level()
    {
        var asm = Compile(new EntityGenerator(), TphAbstractMid);
        Assert.Single(Validate(asm, "Dog", "{\"lo\":1,\"hi\":2,\"kind\":\"FURRY\"}"));
        Assert.Single(Validate(asm, "Dog", "{\"lo\":3,\"hi\":2,\"kind\":\"FURRY\",\"fur\":\"f\"}"));
        Assert.Empty(Validate(asm, "Dog", "{\"lo\":1,\"hi\":2,\"kind\":\"FURRY\",\"fur\":\"f\"}"));
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
