// ADR-0034 Amendment 3 — eject, proof (a): "eject + unchanged copy -> generated output
// byte-identical to the packaged generator for a real fixture."
//
// The tool ships compiled, so an ejected copy is just TEXT until something actually
// compiles it. This test does that for real — via Roslyn, in-memory, the same mechanism
// CodegenCompileConformanceTests already uses to prove generated OUTPUT compiles — but
// here the SOURCE UNDER TEST is the ejected GENERATOR itself: rewrite it exactly as
// `dotnet meta eject` would (EjectableGenerators.RewriteForEject), compile it against
// the PUBLIC MetaObjects.Codegen API only (never a ProjectReference to internals), load
// the resulting assembly, instantiate the generator by reflection, and run it against the
// shared fitness corpus. Its output must equal the packaged generator's, file for file,
// byte for byte. This is also the real verification of "make public whatever an ejected
// copy needs to compile" (task item 2): if a helper is still internal, compilation fails
// here with a concrete CS0122, not a hypothesis.

using System.Reflection;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public class EjectedGeneratorCompileTests
{
    private static MetaRoot LoadCorpus()
    {
        var result = new MetaDataLoader().Load([new FileSource(CorpusPaths.FitnessMetadata)]);
        Assert.True(
            result.Errors.Count == 0,
            "The shared corpus must load cleanly:\n" +
                string.Join("\n", result.Errors.Select(e => $"  {e.Code}: {e.Message}")));
        return result.Root;
    }

    /// <summary>
    /// BCL/EF references (shared with every other Roslyn test in this project) plus the
    /// MetaObjects assemblies an ejected generator's PUBLIC API surface depends on.
    /// Deliberately does NOT reference sibling Generators/*.cs source files — an ejected
    /// copy only ever sees the PACKAGED assembly's public surface, never another
    /// generator's source, so this list is exactly what an adopter's own
    /// codegen/Codegen.csproj would resolve via its MetaObjects.Codegen PackageReference.
    /// </summary>
    private static List<MetadataReference> References()
    {
        var refs = DbContextCompileTests.BuildReferences();
        refs.Add(MetadataReference.CreateFromFile(typeof(IGenerator).Assembly.Location));
        refs.Add(MetadataReference.CreateFromFile(typeof(MetaObject).Assembly.Location));
        refs.Add(MetadataReference.CreateFromFile(typeof(MetaObjects.Render.FilesystemProvider).Assembly.Location));
        return refs;
    }

    /// <summary>
    /// Rewrite (as eject would), compile in-memory, and instantiate <paramref
    /// name="className"/> from the <c>Codegen.Generators</c> namespace the rewrite
    /// targets. Fails the test (not silently) on any compile error or missing type —
    /// this IS the "verify the actual list by compiling" check.
    /// </summary>
    // The real codegen/Codegen.csproj the eject design doc has `dotnet meta eject` write
    // sets <ImplicitUsings>enable</ImplicitUsings> (matching every other project in this
    // repo), which is what lets Generators/*.cs reference List<>/StringComparer/etc. with
    // no explicit `using System.Collections.Generic;` line — the SDK generates exactly
    // this global-usings file into the build. A standalone Roslyn compile has no SDK
    // step, so it is reproduced here; without it, EVERY ejectable generator fails with
    // dozens of CS0246s that have nothing to do with eject's own rewrite.
    private const string ImplicitUsings =
        "global using global::System;\n" +
        "global using global::System.Collections.Generic;\n" +
        "global using global::System.IO;\n" +
        "global using global::System.Linq;\n" +
        "global using global::System.Threading;\n" +
        "global using global::System.Threading.Tasks;\n";

    private static IGenerator CompileAndInstantiate(string stableName, string className, object?[] ctorArgs)
    {
        var source = EjectableGenerators.RewriteForEject(EjectableGenerators.ReadSource(stableName)!);
        var tree = CSharpSyntaxTree.ParseText(source, new CSharpParseOptions(LanguageVersion.CSharp12), path: className + ".cs");
        var implicitUsingsTree = CSharpSyntaxTree.ParseText(ImplicitUsings, new CSharpParseOptions(LanguageVersion.CSharp12), path: "GlobalUsings.g.cs");
        var comp = CSharpCompilation.Create(
            "ejected_" + stableName.Replace('-', '_') + "_" + Guid.NewGuid().ToString("N"),
            [tree, implicitUsingsTree], References(), new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

        using var ms = new MemoryStream();
        var emit = comp.Emit(ms);
        var errors = emit.Diagnostics.Where(d => d.Severity == DiagnosticSeverity.Error).Select(d => d.ToString()).ToList();
        Assert.True(emit.Success,
            $"ejected \"{stableName}\" (rewritten as `dotnet meta eject` would write it) failed to " +
            $"compile against the PUBLIC MetaObjects.Codegen API ({errors.Count} error(s)):\n" +
            string.Join("\n", errors));

        ms.Position = 0;
        var asm = Assembly.Load(ms.ToArray());
        var typeName = "Codegen.Generators." + className;
        var type = asm.GetType(typeName)
            ?? throw new InvalidOperationException($"compiled ejected assembly has no type {typeName}");
        return (IGenerator)(Activator.CreateInstance(type, ctorArgs)
            ?? throw new InvalidOperationException($"could not construct {typeName}"));
    }

    /// <summary>Every ejectable generator with a parameterless constructor, paired with
    /// the C# class name its file declares (render-helper takes a ctor arg — its own
    /// test below).</summary>
    public static TheoryData<string, string> ParameterlessEjectables => new()
    {
        { "entity", "EntityGenerator" },
        { "db-context", "DbContextGenerator" },
        { "routes", "RoutesGenerator" },
        { "output-parser", "OutputParserGenerator" },
        { "extractor", "ExtractorGenerator" },
        { "output-prompt", "OutputPromptGenerator" },
        { "filter-allowlist", "FilterAllowlistGenerator" },
        { "names", "NamesGenerator" },
        { "callable", "CallableGenerator" },
    };

    [Theory]
    [MemberData(nameof(ParameterlessEjectables))]
    public void Ejected_unmodified_copy_compiles_and_matches_the_packaged_generator_byte_for_byte(
        string stableName, string className)
    {
        var root = LoadCorpus();
        var ctx = new GenContext
        {
            Entities = root.Objects(),
            Root = root,
            Config = new GenConfig { OutDir = "/tmp", Namespace = "Acme.Generated", IncludeNames = true },
        };

        var ejected = CompileAndInstantiate(stableName, className, []);
        var ejectedFiles = ejected.Generate(ctx).OrderBy(f => f.Path, StringComparer.Ordinal).ToList();

        var packaged = GeneratorRegistry.Get(stableName)!.Factory(new GeneratorBuildContext());
        var packagedFiles = packaged.Generate(ctx).OrderBy(f => f.Path, StringComparer.Ordinal).ToList();

        // Not every generator emits against this fixture (e.g. "callable" needs a
        // storedProc/tableFunction source, which meta.fitness.json has none of) — the
        // claim under test is PARITY with the packaged generator, not fixture coverage
        // (CodegenCompileConformanceTests already covers "does this corpus exercise the
        // generator at all"). Equal empty lists still proves the ejected copy behaves
        // identically to the packaged one for this input.
        Assert.Equal(packagedFiles.Select(f => f.Path), ejectedFiles.Select(f => f.Path));
        for (int i = 0; i < packagedFiles.Count; i++)
            Assert.Equal(packagedFiles[i].Content, ejectedFiles[i].Content);
    }

    [Fact]
    public void Ejected_render_helper_compiles_and_matches_the_packaged_generator()
    {
        var root = LoadCorpus();
        var ctx = new GenContext
        {
            Entities = root.Objects(),
            Root = root,
            Config = new GenConfig { OutDir = "/tmp", Namespace = "Acme.Generated", IncludeNames = true },
        };

        var ejected = CompileAndInstantiate("render-helper", "RenderHelperGenerator", [CorpusPaths.FitnessTemplateRoot]);
        var ejectedFiles = ejected.Generate(ctx).OrderBy(f => f.Path, StringComparer.Ordinal).ToList();

        var packaged = GeneratorRegistry.Get("render-helper")!.Factory(new GeneratorBuildContext(CorpusPaths.FitnessTemplateRoot));
        var packagedFiles = packaged.Generate(ctx).OrderBy(f => f.Path, StringComparer.Ordinal).ToList();

        Assert.True(ejectedFiles.Count > 0, "render-helper emitted no files against the fixture — nothing was proven");
        Assert.Equal(packagedFiles.Select(f => f.Path), ejectedFiles.Select(f => f.Path));
        for (int i = 0; i < packagedFiles.Count; i++)
            Assert.Equal(packagedFiles[i].Content, ejectedFiles[i].Content);
    }
}
