// ADR-0034 Amendment 3 — eject, proof (a) for the generators with options: "eject + unchanged
// copy -> generated output byte-identical to the packaged generator for a real fixture."
//
// EjectedGeneratorsAloneTests proves it for EVERY registered generator, with its handed-over
// emitters and from the registry; this file keeps the two cases that need more than a default run:
// requirement-tests, which emits nothing for the shared fitness corpus and takes options and
// project hooks. The compile is the same one, so a copy here is the real thing: rewritten
// exactly as `dotnet meta eject` writes it and compiled against the PUBLIC MetaObjects.Codegen API.

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
    /// <c>requirement-tests</c>, over the identity corpus's <c>worked-example</c>: <c>meta.fitness.json</c> has
    /// no requirement, so the generic parity test compares two empty lists for this generator over it and
    /// proves little. Both generators are set to NON-default options so a copy that ignored a property, or
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
        var ejected = EjectedGeneratorsAloneTests.EjectAlone("requirement-tests").Generator;
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

    /// <summary>A project's own filter: keeps everything, the L1 to L3 requirements too.</summary>
    public sealed class ProjectKeepEverythingFilter : IRequirementTestFilter
    {
        public bool Include(RequirementView view) => true;
    }

    /// <summary>A project's own renderer: replaces one test, and keeps the default for the rest.</summary>
    public sealed class ProjectRenderer : IRequirementTestRenderer
    {
        public RenderedTest? Render(RequirementTestArgs args) =>
            args.Identity.Path == "Orders.Recorded"
                ? new RenderedTest(
                    ["System.Linq"],
                    $"[Fact]\npublic void {args.Identity.WitnessKey}()\n{{\n    Assert.True(new[] {{ 1 }}.Any(), \"{args.Identity.Digest}\");\n}}")
                : null;
    }

    /// <summary>
    /// An OWNED copy works with a project's own hooks. The hook types stay in the package, so a project class
    /// implementing <see cref="IRequirementTestFilter"/> or <see cref="IRequirementTestRenderer"/> is accepted by the
    /// copy, and the copy emits the same bytes as the packaged generator given the same hooks. (A port that
    /// defined the hook types inside the ejected file would fail here: the project's class would implement the
    /// package's interface and the copy would want its own.)
    /// </summary>
    [Fact]
    public void Ejected_requirement_tests_accepts_a_project_filter_and_renderer_and_matches_the_packaged_generator()
    {
        var input = Path.Combine(CorpusPaths.RepoRoot(), "fixtures", "requirement-test-identity-conformance", "worked-example", "input");
        var load = MetaDataLoader.FromDirectory(input, strict: true);
        Assert.Empty(load.Errors.Select(e => e.Code + ": " + e.Message));

        var ejected = EjectedGeneratorsAloneTests.EjectAlone("requirement-tests").Generator;
        var ejectedType = ejected.GetType();
        ejectedType.GetProperty("Filter")!.SetValue(ejected, new ProjectKeepEverythingFilter());
        ejectedType.GetProperty("Renderer")!.SetValue(ejected, new ProjectRenderer());
        ejectedType.GetProperty("WarnUncovered")!.SetValue(ejected, false);
        var packaged = new RequirementTestsGenerator
        {
            Filter = new ProjectKeepEverythingFilter(),
            Renderer = new ProjectRenderer(),
            WarnUncovered = false,
        };

        List<EmittedFile> Run(IGenerator generator) =>
            generator.Generate(new GenContext
            {
                Entities = load.Root.Objects(),
                Root = load.Root,
                Config = new GenConfig { OutDir = "/tmp", Namespace = "Acme.Generated" },
            }).OrderBy(f => f.Path, StringComparer.Ordinal).ToList();

        var ejectedFiles = Run(ejected);
        var packagedFiles = Run(packaged);
        var tests = packagedFiles.Single(f => f.Path.EndsWith("_Tests.g.cs", StringComparison.Ordinal)).Content;
        // Both hooks took effect: the filter kept the L3 requirement the default drops, the renderer replaced one test.
        Assert.Contains("// acme::shop::Orders [*]", tests);
        Assert.Contains("using System.Linq;", tests);
        Assert.Contains("Assert.True(new[] { 1 }.Any(), \"2714aa3925a47959aa5e48ae39d80ed203fd4e2caa046a90aab9e04691d9881a\");", tests);
        Assert.Equal(packagedFiles.Select(f => f.Path), ejectedFiles.Select(f => f.Path));
        for (var i = 0; i < packagedFiles.Count; i++)
            Assert.Equal(packagedFiles[i].Content, ejectedFiles[i].Content);
    }
}
