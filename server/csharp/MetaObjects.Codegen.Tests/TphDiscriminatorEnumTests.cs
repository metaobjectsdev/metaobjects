// A TPH discriminator typed by a SHARED or @provided enum (FR-019): HasValue must name the enum
// where it actually lives, not as a type nested in the base entity.

using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using MetaObjects.Codegen;
using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public class TphDiscriminatorEnumTests
{
    private const string Model = """
    { "metadata.root": { "package": "acme", "children": [
      { "field.enum": { "name": "VehicleKind", "abstract": true, "@values": ["Car", "Van"], "@provided": true } },
      { "object.entity": { "name": "Vehicle", "@discriminator": "kind", "children": [
        { "source.rdb": { "@table": "vehicles" } },
        { "field.long": { "name": "id" } },
        { "field.enum": { "name": "kind", "extends": "acme::VehicleKind" } },
        { "identity.primary": { "@fields": "id" } }
      ]}},
      { "object.entity": { "name": "Car", "extends": "Vehicle", "@discriminatorValue": "Car", "children": [
        { "field.int": { "name": "seats" } }
      ]}},
      { "object.entity": { "name": "Van", "extends": "Vehicle", "@discriminatorValue": "Van", "children": [
        { "field.int": { "name": "payloadKg" } }
      ]}}
    ]}}
    """;

    // The adopter's own enum, which @provided says exists at the configured namespace.
    private const string ProvidedEnum = "namespace Acme.Shared { public enum VehicleKind { Car, Van } }";

    [Fact]
    public void A_provided_enum_discriminator_names_the_provided_type_and_compiles()
    {
        var r = new MetaDataLoader().Load([new InMemoryStringSource(Model, id: "tph-provided.json")]);
        Assert.Empty(r.Errors);
        var ctx = new GenContext
        {
            Entities = r.Root.Objects(), Root = r.Root,
            Config = new GenConfig { OutDir = "/tmp", Namespace = "Acme.Generated", ProvidedEnumNamespace = "Acme.Shared" },
        };
        var files = new EntityGenerator().Generate(ctx).Concat(new DbContextGenerator().Generate(ctx)).ToList();
        var context = files.Single(f => f.Path == "AppDbContext.g.cs").Content;
        Assert.Contains(".HasValue<global::Acme.Car>(Acme.Shared.VehicleKind.Car).HasValue<global::Acme.Van>(Acme.Shared.VehicleKind.Van)", context);

        var trees = files.Select(f => f.Content).Append(ProvidedEnum)
            .Select(c => CSharpSyntaxTree.ParseText(c, new CSharpParseOptions(LanguageVersion.CSharp12)));
        var errors = CSharpCompilation.Create("tph_provided_" + Guid.NewGuid().ToString("N"), trees,
                DbContextCompileTests.BuildReferences(), new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary))
            .GetDiagnostics().Where(d => d.Severity == DiagnosticSeverity.Error).Select(d => d.ToString()).ToList();
        Assert.Empty(errors);
    }
}
