// The eject contract, asserted for the C# port (ADR-0034 Amendment 8).
//
// Every stock generator can be ejected, and the owned copy holds its emit. Three
// assertions, each driven by fixtures/generator-registry-conformance/registry.json:
//
//   census        every IGenerator the shipped assemblies define belongs to a registry
//                 entry, and the registry exposes exactly the names the shared file gives
//                 this port.
//   completeness  every registered generator ships eject source, unless the shared file
//                 exempts it with a reason.
//   depth         each generator, ejected ALONE by the real `dotnet meta eject` and compiled
//                 against the published assemblies, references nothing in the codegen
//                 namespaces outside the engine surface, and emits what the packaged
//                 generator emits.
//
// Where the contract does not hold yet, the shared file's `pending` list says so. A pending
// entry that passes fails here, and so does a gap that is not listed.

using System.Reflection;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public class EjectContractTests
{
    // ---------------------------------------------------------------------------------
    // census
    // ---------------------------------------------------------------------------------

    /// <summary>Every concrete <see cref="IGenerator"/> in every MetaObjects assembly this
    /// test project is built with: the shipped packages, found by file, not by a list.</summary>
    private static List<Type> ShippedGeneratorTypes() =>
        Directory.GetFiles(AppContext.BaseDirectory, "MetaObjects*.dll")
            .Where(path => !Path.GetFileNameWithoutExtension(path).EndsWith("Tests", StringComparison.Ordinal))
            .Select(Assembly.LoadFrom)
            .SelectMany(asm => asm.GetTypes())
            .Where(t => typeof(IGenerator).IsAssignableFrom(t) && t is { IsAbstract: false, IsInterface: false })
            .ToList();

    [Fact]
    public void Census_every_generator_type_belongs_to_a_registry_entry()
    {
        var registered = GeneratorRegistry.List()
            .Select(e => e.Factory(new GeneratorBuildContext()).GetType())
            .ToHashSet();
        // TemplateSpecGenerator is how a template spec is declared in codegen/Generators.cs
        // (ADR-0034 Amendment 9). It writes nothing of its own: it runs the spec's `template`
        // generators, which the registry's `template` entry builds.
        registered.Add(typeof(MetaObjects.Codegen.TemplateCodegen.TemplateSpecGenerator));
        // WithHandEdits wraps an entry to carry its handEdits setting. It emits nothing of its own:
        // every file comes from the entry it wraps.
        registered.Add(typeof(IGenerator).Assembly.GetType("MetaObjects.Codegen.HandEditsGenerator", throwOnError: true)!);
        var shipped = ShippedGeneratorTypes();
        Assert.NotEmpty(shipped);
        var unregistered = shipped.Where(t => !registered.Contains(t)).Select(t => t.FullName).OrderBy(n => n).ToList();
        Assert.True(unregistered.Count == 0,
            "generator types no registry entry constructs, so no catalog, eject command or test sees them: " +
            $"[{string.Join(", ", unregistered)}]. Register each in GeneratorRegistry.cs and in {EjectContract.ManifestPath()}.");
    }

    [Fact]
    public void Census_the_registry_exposes_the_names_the_shared_file_gives_this_port()
    {
        var expected = EjectContract.PortSlice();
        var actual = GeneratorRegistry.Entries.Keys.ToHashSet(StringComparer.Ordinal);
        var pending = EjectContract.Pending("census").Keys.OrderBy(n => n, StringComparer.Ordinal).ToList();
        Assert.Empty(actual.Except(expected));
        var missing = expected.Except(actual).OrderBy(n => n, StringComparer.Ordinal).ToList();
        Assert.True(missing.SequenceEqual(pending),
            $"the shared file expects these generators in the C# registry and they are not there: [{string.Join(", ", missing)}]; " +
            $"pending census entries: [{string.Join(", ", pending)}]. Register the generator, or remove the pending entry of one that is now registered.");
    }

    // ---------------------------------------------------------------------------------
    // completeness
    // ---------------------------------------------------------------------------------

    [Fact]
    public void Completeness_every_registered_generator_ships_eject_source_unless_exempt()
    {
        var ejectable = EjectableGenerators.Entries().Select(e => e.Name).ToHashSet(StringComparer.Ordinal);
        var pending = EjectContract.Pending("completeness");
        var problems = new List<string>();
        foreach (var name in GeneratorRegistry.Entries.Keys.OrderBy(n => n, StringComparer.Ordinal))
        {
            if (EjectContract.IsExempt(name))
            {
                if (ejectable.Contains(name)) problems.Add($"{name}: exempt in the shared file but ejectable; drop the exemption");
                continue;
            }
            if (ejectable.Contains(name) && pending.ContainsKey(name))
                problems.Add($"{name}: ejectable now; remove its pending completeness entry");
            if (!ejectable.Contains(name) && !pending.ContainsKey(name))
                problems.Add($"{name}: no eject source, and the shared file does not exempt it");
        }
        problems.AddRange(pending.Keys.Where(n => !GeneratorRegistry.Entries.ContainsKey(n))
            .Select(n => $"{n}: pending completeness entry for a generator this port does not register"));
        Assert.True(problems.Count == 0, string.Join("\n", problems));
    }

    // ---------------------------------------------------------------------------------
    // depth
    // ---------------------------------------------------------------------------------

    // The SDK generates these for a project with <ImplicitUsings>enable</ImplicitUsings>,
    // which is what `dotnet meta eject` writes; a standalone Roslyn compile has no SDK step.
    private const string ImplicitUsings =
        "global using global::System;\n" +
        "global using global::System.Collections.Generic;\n" +
        "global using global::System.IO;\n" +
        "global using global::System.Linq;\n" +
        "global using global::System.Threading;\n" +
        "global using global::System.Threading.Tasks;\n";

    private sealed record OwnedCopy(CSharpCompilation Compilation, IReadOnlyList<SyntaxTree> Trees, Assembly Assembly);

    /// <summary>The owned copy of one generator, alone: every file the real <c>dotnet meta
    /// eject</c> writes under <c>codegen/generators</c> in an empty project (the generator and
    /// the emitters handed over with it), compiled against the published assemblies only,
    /// never a sibling generator's source.</summary>
    private static OwnedCopy CompileAlone(string stableName)
    {
        var project = Directory.CreateTempSubdirectory("eject-contract-").FullName;
        var options = new CSharpParseOptions(LanguageVersion.CSharp12);
        List<SyntaxTree> trees;
        try
        {
            var outcome = MetaObjects.Cli.EjectCommand.Run([stableName], project, force: false);
            Assert.True(outcome.ExitCode == 0, string.Join("\n", outcome.Err));
            trees = Directory.GetFiles(Path.Combine(project, "codegen", "generators"), "*.cs")
                .OrderBy(f => f, StringComparer.Ordinal)
                .Select(f => CSharpSyntaxTree.ParseText(File.ReadAllText(f), options, path: Path.GetFileName(f)))
                .ToList();
            Assert.NotEmpty(trees);
        }
        finally
        {
            Directory.Delete(project, recursive: true);
        }
        var usings = CSharpSyntaxTree.ParseText(ImplicitUsings, options, path: "GlobalUsings.g.cs");
        var references = DbContextCompileTests.BuildReferences();
        references.Add(MetadataReference.CreateFromFile(typeof(IGenerator).Assembly.Location));
        references.Add(MetadataReference.CreateFromFile(typeof(MetaObject).Assembly.Location));
        references.Add(MetadataReference.CreateFromFile(typeof(MetaObjects.Render.FilesystemProvider).Assembly.Location));
        var compilation = CSharpCompilation.Create(
            "owned_" + stableName.Replace('-', '_') + "_" + Guid.NewGuid().ToString("N"),
            [.. trees, usings], references, new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

        using var ms = new MemoryStream();
        var emit = compilation.Emit(ms);
        var errors = emit.Diagnostics.Where(d => d.Severity == DiagnosticSeverity.Error).Select(d => d.ToString()).ToList();
        Assert.True(emit.Success,
            $"\"{stableName}\", ejected alone, does not compile against the published API ({errors.Count} error(s)):\n" +
            string.Join("\n", errors));
        return new OwnedCopy(compilation, trees, Assembly.Load(ms.ToArray()));
    }

    /// <summary>Every type of the packaged codegen assembly the owned copy references, outside
    /// the engine surface. Read from the semantic model, so a <c>using</c> that brings a whole
    /// namespace into scope counts only for what the copy actually names.</summary>
    private static List<string> OutsideEngineSurface(OwnedCopy copy)
    {
        var codegen = typeof(IGenerator).Assembly.GetName().Name;
        var outside = new SortedSet<string>(StringComparer.Ordinal);
        foreach (var tree in copy.Trees)
        {
            var model = copy.Compilation.GetSemanticModel(tree);
            foreach (var name in tree.GetRoot().DescendantNodes().OfType<SimpleNameSyntax>())
            {
                var info = model.GetSymbolInfo(name);
                var symbol = info.Symbol ?? info.CandidateSymbols.FirstOrDefault();
                var type = symbol as INamedTypeSymbol ?? symbol?.ContainingType;
                if (type is null || type.ContainingAssembly?.Name != codegen) continue;
                while (type.ContainingType is not null) type = type.ContainingType;
                var fullName = type.ContainingNamespace.ToDisplayString() + "." + type.Name;
                if (EjectContract.OutsideEngineSurface(fullName)) outside.Add(fullName);
            }
        }
        return outside.ToList();
    }

    [Fact]
    public void Depth_an_owned_copy_references_only_the_engine_surface()
    {
        var pending = EjectContract.Pending("depth");
        var ejectable = EjectableGenerators.Entries().Select(e => e.Name).OrderBy(n => n, StringComparer.Ordinal).ToList();
        var problems = new List<string>();
        foreach (var name in ejectable)
        {
            var actual = OutsideEngineSurface(CompileAlone(name));
            var expected = pending.TryGetValue(name, out var entries)
                ? entries.SelectMany(e => e.Outside ?? []).OrderBy(n => n, StringComparer.Ordinal).ToList()
                : [];
            if (actual.SequenceEqual(expected)) continue;
            if (expected.Count == 0)
                problems.Add($"{name}: its owned copy calls emit code that stays in the package: [{string.Join(", ", actual)}]. " +
                             "Hand it over with the generator; a reference to the engine belongs in eject.engineSurface.csharp.engine.");
            else if (actual.Count == 0)
                problems.Add($"{name}: its owned copy is whole now; remove its pending depth entry");
            else
                problems.Add($"{name}: pending depth entries list [{string.Join(", ", expected)}], the owned copy references [{string.Join(", ", actual)}]");
        }
        problems.AddRange(pending.Keys.Where(n => !ejectable.Contains(n))
            .Select(n => $"{n}: pending depth entry for a generator that is not ejectable"));
        Assert.True(problems.Count == 0, string.Join("\n", problems));
    }

    [Fact]
    public void Depth_every_engine_surface_entry_names_a_real_type()
    {
        var asm = typeof(IGenerator).Assembly;
        var stale = EjectContract.Engine().Where(n => !n.Contains('*') && asm.GetType(n) is null).ToList();
        Assert.True(stale.Count == 0, $"eject.engineSurface.csharp.engine names types that do not exist: [{string.Join(", ", stale)}]");
    }

    private sealed record Corpus(string Label, MetaRoot Root, string? TemplateRoot);

    /// <summary>Shared models that between them make every ejectable generator emit.</summary>
    private static List<Corpus> Corpora()
    {
        MetaRoot Directory(params string[] segments)
        {
            var load = MetaDataLoader.FromDirectory(Path.Combine([CorpusPaths.RepoRoot(), "fixtures", .. segments]), strict: true);
            Assert.Empty(load.Errors.Select(e => e.Code + ": " + e.Message));
            return load.Root;
        }
        return
        [
            new("fitness", EjectedGeneratorCompileTests.LoadCorpus(), CorpusPaths.FitnessTemplateRoot),
            new("requirements", Directory("requirement-test-identity-conformance", "worked-example", "input"), null),
            new("stored-proc", Directory("conformance", "parameter-ref-on-stored-proc", "input"), null),
            // A reply with a nested object: the extractor emits only over one.
            new("nested-reply", Directory("template-output-render-conformance", "xpkg-collision-json"),
                Path.Combine(CorpusPaths.RepoRoot(), "fixtures", "template-output-render-conformance", "templates")),
        ];
    }

    private static IGenerator Instantiate(Assembly owned, string? templateRoot)
    {
        var type = owned.GetTypes().Single(t => typeof(IGenerator).IsAssignableFrom(t) && !t.IsAbstract);
        // The one generator constructed with an argument takes the template root.
        var takesTemplateRoot = type.GetConstructors().Any(c =>
            c.GetParameters() is [{ ParameterType: var p }] && p == typeof(string));
        return (IGenerator)Activator.CreateInstance(type, takesTemplateRoot ? [templateRoot ?? Path.GetTempPath()] : [])!;
    }

    public static TheoryData<string> Ejectable()
    {
        var data = new TheoryData<string>();
        foreach (var entry in EjectableGenerators.Entries()) data.Add(entry.Name);
        return data;
    }

    [Theory]
    [MemberData(nameof(Ejectable))]
    public void Depth_an_unchanged_owned_copy_emits_what_the_packaged_generator_emits(string stableName)
    {
        var copy = CompileAlone(stableName);
        // The one difference an owned copy's output is allowed: it imports the helper
        // runtime the adopter owns where packaged output imports the package's.
        var usesRuntime = HelperRuntime.UsedBy(EjectableGenerators.ReadSource(stableName)!);
        string Expected(string packaged) => usesRuntime
            ? packaged.Replace($"using {HelperRuntime.PackagedNamespace};", $"using {HelperRuntime.OwnedNamespace};", StringComparison.Ordinal)
            : packaged;

        var emitted = 0;
        foreach (var corpus in Corpora())
        {
            List<EmittedFile> Run(IGenerator generator) =>
                generator.Generate(new GenContext
                {
                    Entities = corpus.Root.Objects(),
                    Root = corpus.Root,
                    Config = new GenConfig { OutDir = "/tmp", Namespace = "Acme.Generated", IncludeNames = true },
                }).OrderBy(f => f.Path, StringComparer.Ordinal).ToList();

            var packaged = Run(GeneratorRegistry.Get(stableName)!.Factory(new GeneratorBuildContext(corpus.TemplateRoot)));
            var owned = Run(Instantiate(copy.Assembly, corpus.TemplateRoot));
            emitted += packaged.Count;
            Assert.Equal(packaged.Select(f => f.Path), owned.Select(f => f.Path));
            for (var i = 0; i < packaged.Count; i++)
                Assert.Equal(Expected(packaged[i].Content), owned[i].Content);

            // An owned copy's output reaches into the package's runtime namespace only for
            // core: ExtractObject, the reply parser the prompt tier delegates to.
            var packageRuntimeLines = owned
                .SelectMany(f => f.Content.Split('\n').Select(line => (f.Path, Line: line)))
                .Where(x => x.Line.Contains(HelperRuntime.PackagedNamespace, StringComparison.Ordinal)
                            && !x.Line.Contains("ExtractObject", StringComparison.Ordinal))
                .Select(x => $"{x.Path}: {x.Line.Trim()}")
                .ToList();
            Assert.True(packageRuntimeLines.Count == 0,
                $"owned \"{stableName}\" output still references a helper in {HelperRuntime.PackagedNamespace}:\n" +
                string.Join("\n", packageRuntimeLines));
        }
        Assert.True(emitted > 0, $"{stableName} emitted nothing over the corpora: nothing was compared");
    }
}
