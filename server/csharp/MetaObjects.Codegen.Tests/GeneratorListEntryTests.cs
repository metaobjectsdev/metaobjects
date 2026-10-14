// `dotnet meta gen --list` prints, for every generator, the C# expression that lists it in
// codegen/Generators.cs (GeneratorRegistry.ListEntry). The stable name alone did not say which
// class to construct, and one class (RenderHelperGenerator) takes a constructor argument no
// document showed, so an adopter learned it from a compile error. These tests compile a
// Generators.cs made of exactly the printed expressions, so a wrong class name or a missing
// argument fails here instead of in an adopter's build.

using System.Reflection;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using MetaObjects.Codegen;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public sealed class GeneratorListEntryTests
{
    /// <summary>The `template` primitive is built from a walk and a template the project writes,
    /// so its printed form names the parameters rather than values that compile.</summary>
    private const string TemplatePrimitive = "template";

    [Fact]
    public void Every_printed_entry_compiles_and_builds_the_generator_its_stable_name_names()
    {
        var entries = GeneratorRegistry.List().Where(e => e.Name != TemplatePrimitive).ToList();
        var source =
            "using MetaObjects.Codegen;\n" +
            "public static class Generators\n{\n" +
            "    public static System.Collections.Generic.IReadOnlyList<IGenerator> All { get; } =\n    [\n" +
            string.Concat(entries.Select(e => $"        {GeneratorRegistry.ListEntry(e)},\n")) +
            "    ];\n}\n";

        var all = (IReadOnlyList<IGenerator>)Compile(source).GetType("Generators")!
            .GetProperty("All", BindingFlags.Public | BindingFlags.Static)!.GetValue(null)!;

        Assert.Equal(
            entries.Select(e => e.Factory(new GeneratorBuildContext()).Name),
            all.Select(g => g.Name));
    }

    [Fact]
    public void The_render_helper_entry_shows_its_template_root_argument()
    {
        var entry = GeneratorRegistry.Get("render-helper")!;
        Assert.Equal("new MetaObjects.Codegen.Generators.RenderHelperGenerator(\"prompts\")", GeneratorRegistry.ListEntry(entry));
        Assert.Contains("templateRoot", entry.Options);
    }

    [Fact]
    public void A_plain_entry_is_its_full_class_name()
    {
        Assert.Equal("new MetaObjects.Codegen.Generators.EntityGenerator()", GeneratorRegistry.ListEntry(GeneratorRegistry.Get("entity")!));
    }

    private static Assembly Compile(string source)
    {
        var refs = ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!)
            .Split(Path.PathSeparator).Where(p => p.Length > 0)
            .Select(p => (MetadataReference)MetadataReference.CreateFromFile(p)).ToList();
        refs.Add(MetadataReference.CreateFromFile(typeof(IGenerator).Assembly.Location));
        refs.Add(MetadataReference.CreateFromFile(typeof(MetaObject).Assembly.Location));
        refs.Add(MetadataReference.CreateFromFile(typeof(MetaObjects.Render.Extract.ExtractSchema).Assembly.Location));

        var comp = CSharpCompilation.Create(
            "generator_list_" + Guid.NewGuid().ToString("N"),
            [CSharpSyntaxTree.ParseText(source, new CSharpParseOptions(LanguageVersion.CSharp12))],
            refs,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        using var ms = new MemoryStream();
        var emit = comp.Emit(ms);
        var errors = emit.Diagnostics.Where(d => d.Severity == DiagnosticSeverity.Error)
            .Select(d => $"{d.Id}: {d.GetMessage()}").ToList();
        Assert.True(errors.Count == 0, "the printed Generators.cs entries should compile, got: " + string.Join("; ", errors));
        return Assembly.Load(ms.ToArray());
    }
}
