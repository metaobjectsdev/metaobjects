// ADR-0034 Amendment 3 — eject hands over the emitters a generator writes its output through
// (GeneratorRegistryEntry.Companions), not just the generator. The compile-and-engine-surface
// proof is MetaObjects.Codegen.Tests' EjectedGeneratorsAloneTests; this is the command's half:
// what `dotnet meta eject <name>` actually writes, derived from the registry for every name.

using MetaObjects.Cli;
using MetaObjects.Codegen;
using Xunit;

namespace MetaObjects.Cli.Tests;

public sealed class EjectCompanionsTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "meta-eject-companions-" + Guid.NewGuid().ToString("N"));
    private string Owned(string relative) => Path.Combine(_root, relative.Replace('/', Path.DirectorySeparatorChar));

    public EjectCompanionsTests() => Directory.CreateDirectory(_root);
    public void Dispose() { try { Directory.Delete(_root, recursive: true); } catch { } }

    public static TheoryData<string> Ejectables
    {
        get
        {
            var data = new TheoryData<string>();
            foreach (var name in EjectCommand.EjectableNames()) data.Add(name);
            return data;
        }
    }

    [Theory]
    [MemberData(nameof(Ejectables))]
    public void Ejecting_a_generator_alone_writes_its_source_and_its_emitters_and_nothing_else_of_the_packages(string name)
    {
        var entry = GeneratorRegistry.Get(name)!;
        var outcome = EjectCommand.Run([name], _root, force: false);
        Assert.Equal(0, outcome.ExitCode);

        // Everything under codegen/ the command wrote: the files it names, the scaffold, and the helper
        // runtime for a generator whose output imports it.
        var written = Directory.GetFiles(Owned("codegen"), "*", SearchOption.AllDirectories)
            .Select(f => Path.GetRelativePath(_root, f).Replace(Path.DirectorySeparatorChar, '/'))
            .Where(f => f is not "codegen/Codegen.csproj" and not "codegen/Program.cs" && !f.StartsWith("codegen/runtime/", StringComparison.Ordinal))
            .Order(StringComparer.Ordinal)
            .ToList();
        var expected = EjectableGenerators.SourcePaths(entry)
            .Select(EjectableGenerators.OwnedRelativePath)
            .Order(StringComparer.Ordinal)
            .ToList();
        Assert.Equal(expected, written);

        // Each is the embedded source, rewritten the one way eject rewrites it.
        foreach (var sourcePath in EjectableGenerators.SourcePaths(entry))
            Assert.Equal(
                EjectableGenerators.RewriteForEject(EjectableGenerators.ReadSourcePath(sourcePath)),
                File.ReadAllText(Owned(EjectableGenerators.OwnedRelativePath(sourcePath))));
    }

    [Fact]
    public void An_emitter_two_generators_share_is_copied_once_and_the_report_names_it()
    {
        var outcome = EjectCommand.Run(["output-parser", "extractor"], _root, force: false);
        Assert.Equal(0, outcome.ExitCode);

        var report = string.Join("\n", outcome.Out);
        Assert.Equal(1, System.Text.RegularExpressions.Regex.Matches(report, @"codegen/generators/ExtractDelegateEmitter\.cs \[created\]").Count);
        Assert.Contains("codegen/generators/Fr010FieldMapping.cs [created]", report);
        Assert.Contains("codegen/generators/Fr019SharedEnum.cs [created]", report);
    }

    [Fact]
    public void A_later_eject_keeps_an_emitter_already_yours_and_force_replaces_it()
    {
        Assert.Equal(0, EjectCommand.Run(["output-parser"], _root, force: false).ExitCode);
        var emitter = Owned("codegen/generators/ExtractDelegateEmitter.cs");
        File.AppendAllText(emitter, "// my edit\n");
        var edited = File.ReadAllText(emitter);

        // `extractor` shares the emitter: it is not a refusal, and the edit survives.
        var second = EjectCommand.Run(["extractor"], _root, force: false);
        Assert.Equal(0, second.ExitCode);
        Assert.Contains("codegen/generators/ExtractDelegateEmitter.cs [kept — already yours]", string.Join("\n", second.Out));
        Assert.Equal(edited, File.ReadAllText(emitter));

        // --force replaces the generator copy and its emitters with the reference, as it always has.
        var forced = EjectCommand.Run(["extractor"], _root, force: true);
        Assert.Equal(0, forced.ExitCode);
        Assert.Contains("codegen/generators/ExtractDelegateEmitter.cs [replaced]", string.Join("\n", forced.Out));
        Assert.DoesNotContain("my edit", File.ReadAllText(emitter));
    }

    [Fact]
    public void A_generator_with_no_emitters_reports_none()
    {
        var outcome = EjectCommand.Run(["filter-allowlist"], _root, force: false);
        Assert.DoesNotContain("emitters", string.Join("\n", outcome.Out));
    }

    [Fact]
    public void Ejecting_api_docs_wires_it_into_the_scaffolded_program()
    {
        Assert.Equal(0, EjectCommand.Run(["api-docs"], _root, force: false).ExitCode);

        var program = File.ReadAllText(Owned("codegen/Program.cs"));
        Assert.Contains("new ApiDocsGenerator(),", program);
        Assert.True(File.Exists(Owned("codegen/generators/CSharpApiModelBuilder.cs")));
    }

    [Fact]
    public void Docs_hand_off_to_the_owned_project_only_when_the_project_owns_api_docs()
    {
        Assert.False(CodegenHandoff.HasOwnedDocs(_root));

        // A project that ejected something else has an owned codegen project, and `gen` hands off to it; `docs`
        // does not, because that project's package may predate the `docs` command.
        Assert.Equal(0, EjectCommand.Run(["entity"], _root, force: false).ExitCode);
        Assert.True(CodegenHandoff.HasOwnedCodegen(_root));
        Assert.False(CodegenHandoff.HasOwnedDocs(_root));

        Assert.Equal(0, EjectCommand.Run(["api-docs"], _root, force: false).ExitCode);
        Assert.True(CodegenHandoff.HasOwnedDocs(_root));
    }
}
