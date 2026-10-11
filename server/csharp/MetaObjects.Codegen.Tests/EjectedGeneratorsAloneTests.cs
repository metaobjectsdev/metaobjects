// ADR-0034 Amendment 3 — eject, the depth gate: every ejectable generator, ejected ALONE.
//
// The eject tests that came before this one proved that a copy compiles and matches the
// packaged generator. They could not say what the copy still LEANS ON: a copy that calls the
// package's emitters compiles, matches, and is a shell — a defect in the code it writes would
// still wait for a MetaObjects release. So this test asks the question directly, for every
// generator the registry says is ejectable, never from a list typed by hand:
//
//   1. COMPILES ALONE — the generator and the files eject hands over with it (its registry
//      entry's SourceFileName + Companions), rewritten exactly as `dotnet meta eject` writes
//      them, compile against the package's PUBLIC API and nothing else: no sibling generator's
//      source, no other generator's companions.
//   2. LEANS ONLY ON THE ENGINE — every type of the package the compiled copy references is on
//      the engine surface below. A packaged emitter, generator or docs writer is not.
//   3. OWNS EVERY COMPANION — each companion file is used, so the list is the closure and not a
//      habit.
//   4. SAME BYTES — run over the shared corpora, the copy emits exactly what the packaged
//      generator emits.
//
// THE ENGINE SURFACE is what an owned copy is allowed to call in the package (ruled in the
// eject audit, question 2): the generator base and its config and context, the naming and
// type-mapping tables, the model questions a generator asks (which entities are persisted,
// which template is inbound, how a package binds to a namespace), the hook types a project
// implements, and the runtime the generated code is compiled with. Everything that RETURNS
// EMITTED TEXT is handed over instead. Each entry carries the reason it is engine; the test
// fails on a referenced type that is not listed, and on a listed type nothing references.

using System.Reflection;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public class EjectedGeneratorsAloneTests
{
    private const string PackageAssembly = "MetaObjects.Codegen";

    /// <summary>The package types an owned copy may call, each with why it is engine rather than emit.</summary>
    internal static readonly IReadOnlyDictionary<string, string> EngineSurface = new Dictionary<string, string>(StringComparer.Ordinal)
    {
        // The generator model.
        ["MetaObjects.Codegen.IGenerator"] = "the generator contract",
        ["MetaObjects.Codegen.IDocsGenerator"] = "the docs-surface marker the runner partitions on",
        ["MetaObjects.Codegen.EmittedFile"] = "the generator's output record",
        ["MetaObjects.Codegen.GenContext"] = "the per-run state handed to every generator",
        ["MetaObjects.Codegen.GenConfig"] = "the resolved generation config",
        ["MetaObjects.Codegen.DocsRunFacts"] = "the facts of a docs run, carried on GenContext",
        ["MetaObjects.Codegen.GeneratorApplicability"] = "what the docs generator asks of the generators it documents, answered by the run",
        ["MetaObjects.Codegen.PerEntityGenerator"] = "the one-file-per-entity base class",
        ["MetaObjects.Codegen.ColumnNamingStrategy"] = "config enum read by naming",
        // Naming, type mapping and binding: tables, ruled engine.
        ["MetaObjects.Codegen.CSharpNaming"] = "the naming and type-mapping tables",
        ["MetaObjects.Codegen.ValueObjectNames"] = "the one answer to what a value object's type is called and where it lives",
        ["MetaObjects.Codegen.PackageBindingResolver"] = "package -> namespace binding",
        // Questions about the model.
        ["MetaObjects.Codegen.InstanceArtifacts"] = "the predicate: does this object produce instance artifacts",
        ["MetaObjects.Codegen.ReportRows"] = "the row model a view-backed report is generated from: a model derivation",
        ["MetaObjects.Codegen.Generators.FindInbound"] = "the model walk: which templates are inbound and what shape they return",
        ["MetaObjects.Codegen.Generators.InboundShape"] = "what FindInbound returns: the response value object and its format",
        ["MetaObjects.Codegen.Generators.TphPlan"] = "the model plan: which entities share a table and how they are told apart",
        ["MetaObjects.Codegen.Generators.TphPlanBuilder"] = "builds the TPH plan from the model",
        ["MetaObjects.Codegen.Generators.TphSubtypePlan"] = "one subtype's place in the TPH plan",
        ["MetaObjects.Codegen.ObjectNames"] = "the resolved physical names of an object, what CSharpNaming returns",
        ["MetaObjects.Codegen.FieldNames"] = "the resolved physical names of a field, what CSharpNaming returns",
        ["MetaObjects.Codegen.KeyNames"] = "the resolved physical names of a key, what CSharpNaming returns",
        ["MetaObjects.Codegen.SourceNames"] = "the resolved physical names of a source, what CSharpNaming returns",
        ["MetaObjects.Codegen.SuperNames"] = "the resolved physical names of a super, what CSharpNaming returns",
        // Hooks a project implements; the generator that calls them is a copy, the types stay shared.
        ["MetaObjects.Codegen.IRequirementTestRenderer"] = "hook type a project implements",
        ["MetaObjects.Codegen.RequirementTestArgs"] = "hook argument type",
        ["MetaObjects.Codegen.RequirementTestClaim"] = "hook argument type",
        ["MetaObjects.Codegen.RenderedTest"] = "hook result type",
    };

    /// <summary>What a registered generator may be without an eject source, and why.</summary>
    internal static readonly IReadOnlyDictionary<string, string> NotEjectable = new Dictionary<string, string>(StringComparer.Ordinal)
    {
        ["template"] = "the Mustache primitive has no emit logic of its own to own (ADR-0034 Amendment 3, ruled again for 1.1.0)",
    };

    // The SDK generates these for every project that sets <ImplicitUsings>enable</ImplicitUsings>, which the
    // codegen/Codegen.csproj eject writes does; a standalone Roslyn compile has no SDK step.
    private const string ImplicitUsings =
        "global using global::System;\n" +
        "global using global::System.Collections.Generic;\n" +
        "global using global::System.IO;\n" +
        "global using global::System.Linq;\n" +
        "global using global::System.Threading;\n" +
        "global using global::System.Threading.Tasks;\n";

    /// <summary>Every registered generator that has an eject source — from the registry, never typed here.</summary>
    public static TheoryData<string> Ejectables
    {
        get
        {
            var data = new TheoryData<string>();
            foreach (var entry in EjectableGenerators.Entries()) data.Add(entry.Name);
            return data;
        }
    }

    internal sealed record Alone(
        GeneratorRegistryEntry Entry, CSharpCompilation Compilation, IReadOnlyList<(string Path, SyntaxTree Tree)> Trees, IGenerator Generator);

    /// <summary>
    /// Eject <paramref name="name"/> alone: its source and its companions, rewritten as eject writes
    /// them, compiled against the package's public API. Fails the test on a compile error.
    /// <paramref name="asEjectedBefore"/> edits the generator's own file to the shape an older eject wrote.
    /// </summary>
    internal static Alone EjectAlone(string name, Func<string, string>? asEjectedBefore = null)
    {
        var entry = GeneratorRegistry.Get(name)!;
        var parse = new CSharpParseOptions(LanguageVersion.CSharp12);
        var trees = EjectableGenerators.SourcePaths(entry)
            .Select(path => (Path: path, Tree: CSharpSyntaxTree.ParseText(
                (path == "Generators/" + entry.SourceFileName ? asEjectedBefore ?? (x => x) : x => x)(
                    EjectableGenerators.RewriteForEject(EjectableGenerators.ReadSourcePath(path))),
                parse, path: path)))
            .ToList();
        var comp = CSharpCompilation.Create(
            "ejected_" + name.Replace('-', '_') + "_" + Guid.NewGuid().ToString("N"),
            [.. trees.Select(t => t.Tree), CSharpSyntaxTree.ParseText(ImplicitUsings, parse, path: "GlobalUsings.g.cs")],
            References(), new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

        using var ms = new MemoryStream();
        var emit = comp.Emit(ms);
        var errors = emit.Diagnostics.Where(d => d.Severity == DiagnosticSeverity.Error).Select(d => d.ToString()).ToList();
        Assert.True(emit.Success,
            $"\"{name}\" ejected alone — {string.Join(", ", trees.Select(t => t.Path))}, rewritten as `dotnet meta eject` " +
            $"writes them — failed to compile against the PUBLIC MetaObjects.Codegen API ({errors.Count} error(s)). " +
            "A missing type is a companion the registry entry does not list; an inaccessible one is an emitter " +
            "that must be made public or handed over:\n" + string.Join("\n", errors));

        ms.Position = 0;
        var asm = Assembly.Load(ms.ToArray());
        var className = Path.GetFileNameWithoutExtension(entry.SourceFileName!);
        var type = asm.GetType("Codegen.Generators." + className)
            ?? throw new InvalidOperationException($"compiled ejected assembly has no type Codegen.Generators.{className}");
        return new Alone(entry, comp, trees, Construct(type));
    }

    private static IGenerator Construct(Type type)
    {
        // A generator takes either nothing or the template root (render-helper); anything else is a new
        // shape this test must be taught, which is the point of failing here.
        var ctor = type.GetConstructors().Single();
        var args = ctor.GetParameters().Select(p => p.ParameterType == typeof(string) && p.Name == "templateRoot"
            ? (object)CorpusPaths.FitnessTemplateRoot
            : throw new InvalidOperationException($"{type.Name}'s constructor takes {p.ParameterType.Name} {p.Name}; teach EjectedGeneratorsAloneTests how to supply it")).ToArray();
        return (IGenerator)ctor.Invoke(args);
    }

    private static List<MetadataReference> References()
    {
        var refs = DbContextCompileTests.BuildReferences();
        refs.Add(MetadataReference.CreateFromFile(typeof(IGenerator).Assembly.Location));
        refs.Add(MetadataReference.CreateFromFile(typeof(MetaObject).Assembly.Location));
        refs.Add(MetadataReference.CreateFromFile(typeof(MetaObjects.Render.FilesystemProvider).Assembly.Location));
        return refs;
    }

    /// <summary>The top-level types of the package that <paramref name="alone"/>'s compiled files reference.</summary>
    internal static SortedSet<string> PackagedTypesReferenced(Alone alone)
    {
        var found = new SortedSet<string>(StringComparer.Ordinal);
        void Note(ISymbol? symbol)
        {
            var type = symbol as INamedTypeSymbol ?? symbol?.ContainingType;
            while (type?.ContainingType is { } outer) type = outer;
            if (type is { ContainingAssembly.Name: PackageAssembly })
                found.Add(type.OriginalDefinition.ToDisplayString());
        }
        foreach (var (_, tree) in alone.Trees)
        {
            var model = alone.Compilation.GetSemanticModel(tree);
            foreach (var node in tree.GetRoot().DescendantNodes())
            {
                switch (node)
                {
                    case SimpleNameSyntax name:
                        Note(model.GetSymbolInfo(name).Symbol);
                        break;
                    case ObjectCreationExpressionSyntax or ImplicitObjectCreationExpressionSyntax:
                        Note(model.GetTypeInfo(node).Type);
                        break;
                }
            }
        }
        // The types the copy's own files declare are not the package's, whatever their namespace says.
        return found;
    }

    [Theory]
    [MemberData(nameof(Ejectables))]
    public void Ejected_alone_it_compiles_against_the_public_API(string name)
    {
        var alone = EjectAlone(name);
        Assert.NotEmpty(alone.Trees);
    }

    [Theory]
    [MemberData(nameof(Ejectables))]
    public void Ejected_alone_it_calls_the_package_only_through_the_engine_surface(string name)
    {
        var alone = EjectAlone(name);
        var emitters = PackagedTypesReferenced(alone).Where(t => !EngineSurface.ContainsKey(t)).ToList();
        Assert.True(emitters.Count == 0,
            $"\"{name}\" ejected alone still calls the package's {string.Join(", ", emitters)}. A type that returns " +
            "emitted text is handed over with the generator (list it in the registry entry's Companions, and make " +
            "any inaccessible member it needs public); a type that is a table or a model question is engine and " +
            "goes on EjectedGeneratorsAloneTests.EngineSurface with the reason.");
    }

    [Theory]
    [MemberData(nameof(Ejectables))]
    public void Ejected_alone_every_companion_is_used(string name)
    {
        var alone = EjectAlone(name);
        foreach (var companion in alone.Entry.Companions)
        {
            var tree = alone.Trees.Single(t => t.Path == companion).Tree;
            var declared = tree.GetRoot().DescendantNodes().OfType<BaseTypeDeclarationSyntax>()
                .Where(d => d.Parent is not BaseTypeDeclarationSyntax)
                .Select(d => alone.Compilation.GetSemanticModel(tree).GetDeclaredSymbol(d)!)
                .ToList();
            var used = alone.Trees.Where(t => t.Path != companion).Any(other =>
            {
                var model = alone.Compilation.GetSemanticModel(other.Tree);
                return other.Tree.GetRoot().DescendantNodes().OfType<SimpleNameSyntax>().Any(n =>
                {
                    var symbol = model.GetSymbolInfo(n).Symbol;
                    var type = symbol as INamedTypeSymbol ?? symbol?.ContainingType;
                    return type is not null && declared.Any(d => SymbolEqualityComparer.Default.Equals(d, type.OriginalDefinition));
                });
            });
            Assert.True(used,
                $"\"{name}\" hands over {companion}, but neither the generator nor another companion calls it. " +
                "Remove it from the registry entry's Companions: an owned copy should not carry code it does not run.");
        }
    }

    /// <summary>The corpora every generator is run over: the shared fitness model, and the worked example (the
    /// one with requirements, which the fitness model has none of).</summary>
    private static IEnumerable<(string Label, MetaRoot Root)> Corpora(string generator)
    {
        // The prompt tier emits only for a responding prompt, and the extractor only for one whose response
        // nests an object: neither shared corpus has that, so those generators also run over the nested-reply
        // model the extractor's own codegen tests use. (render-helper is left off it: its template files live
        // under the fitness template root, and the model names others.)
        if (generator is "output-parser" or "extractor" or "output-prompt")
        {
            var nested = new MetaDataLoader().Load([new InMemoryStringSource(ExtractorCodegenTests.Model, id: "orders.json")]);
            Assert.Empty(nested.Errors.Select(e => e.Code + ": " + e.Message));
            yield return ("nested-reply", nested.Root);
        }
        yield return ("fitness", EjectedGeneratorCompileTests.LoadCorpus());
        var worked = MetaDataLoader.FromDirectory(
            Path.Combine(CorpusPaths.RepoRoot(), "fixtures", "requirement-test-identity-conformance", "worked-example", "input"), strict: true);
        Assert.Empty(worked.Errors.Select(e => e.Code + ": " + e.Message));
        yield return ("worked-example", worked.Root);
    }

    private static List<EmittedFile> Run(IGenerator generator, MetaRoot root)
    {
        var ctx = new GenContext
        {
            Entities = root.Objects(),
            Root = root,
            Config = new GenConfig { OutDir = "/tmp", Namespace = "Acme.Generated", IncludeNames = true },
            Docs = new DocsRunFacts("fitness"),
        };
        return generator.Generate(ctx).OrderBy(f => f.Path, StringComparer.Ordinal).ToList();
    }

    [Theory]
    [MemberData(nameof(Ejectables))]
    public void Ejected_alone_it_emits_what_the_packaged_generator_emits_byte_for_byte(string name)
    {
        var alone = EjectAlone(name);
        var packaged = GeneratorRegistry.Get(name)!.Factory(new GeneratorBuildContext(CorpusPaths.FitnessTemplateRoot));
        // The ONE documented difference: a generator whose output imports the helper runtime imports the
        // adopter's owned copy once ejected — `using Codegen.Runtime;` where the packaged output says
        // `using MetaObjects.Codegen.Runtime;`. Nothing else.
        var usesRuntime = HelperRuntime.UsedBy(EjectableGenerators.ReadSource(name)!);
        string Expected(string content) => usesRuntime
            ? content.Replace($"using {HelperRuntime.PackagedNamespace};", $"using {HelperRuntime.OwnedNamespace};", StringComparison.Ordinal)
            : content;

        var emitted = 0;
        foreach (var (label, root) in Corpora(name))
        {
            var want = Run(packaged, root);
            var got = Run(alone.Generator, root);
            Assert.True(want.Select(f => f.Path).SequenceEqual(got.Select(f => f.Path)),
                $"\"{name}\" over {label}: the copy emits different files than the packaged generator.");
            for (var i = 0; i < want.Count; i++)
                Assert.True(Expected(want[i].Content) == got[i].Content,
                    $"\"{name}\" over {label}: {want[i].Path} differs between the packaged generator and the ejected copy.");
            // An ejected copy's output reaches into the package's runtime namespace ONLY for core: ExtractObject,
            // the reply parser the prompt tier delegates to. Every helper type it calls is the adopter's own copy.
            var packageRuntimeLines = got
                .SelectMany(f => f.Content.Split('\n').Select(l => (f.Path, Line: l)))
                .Where(x => x.Line.Contains(HelperRuntime.PackagedNamespace, StringComparison.Ordinal)
                            && !x.Line.Contains("ExtractObject", StringComparison.Ordinal))
                .Select(x => $"{x.Path}: {x.Line.Trim()}")
                .ToList();
            Assert.True(packageRuntimeLines.Count == 0,
                $"ejected \"{name}\" output over {label} still references a helper in {HelperRuntime.PackagedNamespace}:\n" +
                string.Join("\n", packageRuntimeLines));
            emitted += want.Count;
        }
        // Parity of two empty lists proves nothing, so a generator must emit over at least one corpus. The one
        // exception is `callable`: it needs a stored-proc or table-function source, which neither corpus has.
        if (name != "callable")
            Assert.True(emitted > 0, $"\"{name}\" emitted nothing over either corpus, so nothing was proven about it.");
    }

    [Fact]
    public void A_copy_ejected_before_the_emitters_were_handed_over_binds_to_the_ones_copied_in_later()
    {
        // The upgrade path for an existing owned copy: its file is as an older eject wrote it, with the
        // package's emitter namespaces still imported, and the emitters are copied in beside it. Names in the
        // copy's own namespace win over names a using brings in, so the copy reaches the owned emitters.
        var alone = EjectAlone("entity", source => "using MetaObjects.Codegen.Docs;\n" + source);

        var emitters = PackagedTypesReferenced(alone).Where(t => !EngineSurface.ContainsKey(t)).ToList();
        Assert.True(emitters.Count == 0, $"an older copy still binds to the package's {string.Join(", ", emitters)}");
    }

    [Fact]
    public void Every_registered_generator_is_ejectable_or_exempt_with_a_reason()
    {
        foreach (var entry in GeneratorRegistry.List())
        {
            if (entry.SourceFileName is not null)
            {
                Assert.DoesNotContain(entry.Name, NotEjectable.Keys);
                continue;
            }
            Assert.True(NotEjectable.TryGetValue(entry.Name, out var reason) && reason.Length > 0,
                $"\"{entry.Name}\" is registered with no eject source and no written exemption. Make it ejectable, " +
                "or add it to EjectedGeneratorsAloneTests.NotEjectable with the ruling that exempts it.");
        }
        foreach (var exempt in NotEjectable.Keys)
            Assert.NotNull(GeneratorRegistry.Get(exempt));
    }

    [Fact]
    public void Every_generator_class_the_package_ships_is_registered()
    {
        var registered = GeneratorRegistry.List()
            .Select(e => e.Factory(new GeneratorBuildContext()).GetType())
            .ToHashSet();
        var shipped = typeof(IGenerator).Assembly.GetExportedTypes()
            .Where(t => t is { IsClass: true, IsAbstract: false } && typeof(IGenerator).IsAssignableFrom(t))
            .Where(t => !registered.Contains(t))
            .Select(t => t.FullName)
            .ToList();
        Assert.True(shipped.Count == 0,
            "the package ships a generator no registry entry builds, so no catalog, eject command or test sees it: " +
            string.Join(", ", shipped));
    }

    [Fact]
    public void The_engine_surface_lists_only_types_some_ejected_copy_references_and_that_exist()
    {
        var referencedBySome = EjectableGenerators.Entries()
            .SelectMany(e => PackagedTypesReferenced(EjectAlone(e.Name)))
            .ToHashSet(StringComparer.Ordinal);
        var packageTypes = typeof(IGenerator).Assembly.GetExportedTypes().Select(t => t.FullName!).ToHashSet(StringComparer.Ordinal);

        var missing = EngineSurface.Keys.Where(k => !packageTypes.Contains(k)).ToList();
        Assert.True(missing.Count == 0, $"engine surface names types the package does not export: {string.Join(", ", missing)}");
        var stale = EngineSurface.Keys.Where(k => !referencedBySome.Contains(k)).ToList();
        Assert.True(stale.Count == 0,
            $"engine surface lists types no ejected copy references (remove them): {string.Join(", ", stale)}");
    }
}
