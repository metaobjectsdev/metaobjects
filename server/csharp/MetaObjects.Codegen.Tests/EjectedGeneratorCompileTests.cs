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
using MetaObjects.Codegen.Generators;
using MetaObjects.Core.Requirement;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public class EjectedGeneratorCompileTests
{
    internal static MetaRoot LoadCorpus()
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

    internal static IGenerator CompileAndInstantiate(string stableName, string className, object?[] ctorArgs)
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
        //
        // The ONE documented difference: a generator whose output imports the helper runtime
        // (routes) imports the adopter's owned copy once ejected — `using Codegen.Runtime;`
        // where the packaged output says `using MetaObjects.Codegen.Runtime;`. Nothing else.
        var usesRuntime = HelperRuntime.UsedBy(EjectableGenerators.ReadSource(stableName)!);
        string Expected(string packagedContent) => usesRuntime
            ? packagedContent.Replace(
                $"using {HelperRuntime.PackagedNamespace};", $"using {HelperRuntime.OwnedNamespace};", StringComparison.Ordinal)
            : packagedContent;

        Assert.Equal(packagedFiles.Select(f => f.Path), ejectedFiles.Select(f => f.Path));
        for (int i = 0; i < packagedFiles.Count; i++)
            Assert.Equal(Expected(packagedFiles[i].Content), ejectedFiles[i].Content);

        // And an ejected copy's output reaches into the package's runtime namespace ONLY for
        // core: ExtractObject, the reply parser the prompt tier delegates to. Every helper
        // type it calls is the adopter's own copy.
        var packageRuntimeLines = ejectedFiles
            .SelectMany(f => f.Content.Split('\n').Select(l => (f.Path, Line: l)))
            .Where(x => x.Line.Contains(HelperRuntime.PackagedNamespace, StringComparison.Ordinal)
                        && !x.Line.Contains("ExtractObject", StringComparison.Ordinal))
            .Select(x => $"{x.Path}: {x.Line.Trim()}")
            .ToList();
        Assert.True(packageRuntimeLines.Count == 0,
            $"ejected \"{stableName}\" output still references a helper in {HelperRuntime.PackagedNamespace}:\n" +
            string.Join("\n", packageRuntimeLines));
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

    /// <summary>
    /// <c>requirement-tests</c>, over the identity corpus's <c>worked-example</c>: <c>meta.fitness.json</c> has
    /// no requirement, so the parameterless theory above compares two empty lists for this generator and
    /// proves nothing. Both generators are set to NON-default options so a copy that ignored a property, or
    /// that fell back to its own defaults, could not agree with the packaged one by accident.
    /// </summary>
    [Fact]
    public void Ejected_requirement_tests_compiles_against_the_public_API_and_matches_the_packaged_generator_over_the_worked_example()
    {
        var input = Path.Combine(CorpusPaths.RepoRoot(), "fixtures", "requirement-test-identity-conformance", "worked-example", "input");
        var load = MetaDataLoader.FromDirectory(input, strict: true);
        Assert.Empty(load.Errors.Select(e => e.Code + ": " + e.Message));

        const string testNamespace = "Acme.Owned.Req";
        const string witnessClass = "Acme.Owned.Witnesses";
        var ejected = CompileAndInstantiate("requirement-tests", "RequirementTestsGenerator", []);
        Assert.Equal("Codegen.Generators", ejected.GetType().Namespace);
        foreach (var (property, value) in new (string, object)[]
                 {
                     ("TestNamespace", testNamespace),
                     ("WitnessClass", witnessClass),
                     ("Grain", RequirementTestGrain.Member),
                     ("WarnUncovered", true),
                 })
            ejected.GetType().GetProperty(property)!.SetValue(ejected, value);

        var packaged = new RequirementTestsGenerator
        {
            TestNamespace = testNamespace,
            WitnessClass = witnessClass,
            Grain = RequirementTestGrain.Member,
            WarnUncovered = true,
        };

        List<EmittedFile> Run(IGenerator generator, List<string> warnings) =>
            generator.Generate(new GenContext
            {
                Entities = load.Root.Objects(),
                Root = load.Root,
                Config = new GenConfig { OutDir = "/tmp", Namespace = "Acme.Generated" },
                Warn = warnings.Add,
            }).OrderBy(f => f.Path, StringComparer.Ordinal).ToList();

        var ejectedWarnings = new List<string>();
        var packagedWarnings = new List<string>();
        var ejectedFiles = Run(ejected, ejectedWarnings);
        var packagedFiles = Run(packaged, packagedWarnings);

        Assert.Equal(2, packagedFiles.Count);
        Assert.Contains($"namespace {testNamespace};", packagedFiles[0].Content);
        Assert.Contains("req_acme_shop_Orders_Recorded__Order", packagedFiles[0].Content + packagedFiles[1].Content);
        Assert.Equal(packagedFiles.Select(f => f.Path), ejectedFiles.Select(f => f.Path));
        for (var i = 0; i < packagedFiles.Count; i++)
            Assert.Equal(packagedFiles[i].Content, ejectedFiles[i].Content);
        // The worked example has one requirement the default filter drops, so each says so, in the same words.
        Assert.Single(packagedWarnings);
        Assert.Equal(packagedWarnings, ejectedWarnings);
    }
}
