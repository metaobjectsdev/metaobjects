// ADR-0034 Amendment 3 — eject. `EjectableGenerators` is the embedded-resource surface
// `dotnet meta eject` reads from (never the file on disk — the tool ships compiled, so
// there is no source tree beside it). These tests gate the two things that would let a
// packaged generator silently diverge from what `eject` hands an adopter:
//   1. the embedded copy is byte-identical to its Generators/<file> source (drift gate);
//   2. the embedded RESOURCE SET matches exactly the registry's ejectable entries (so a
//      new ejectable generator can't ship without its embed, and vice versa).
// Also covers the deliberate edit `RewriteForEject` makes (the namespace rename —
// see its own doc comment for why one is needed at all).

using System.Reflection;
using MetaObjects.Codegen;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public class EjectableGeneratorsTests
{
    private static string GeneratorsDir() =>
        Path.Combine(CorpusPaths.RepoRoot(), "server", "csharp", "MetaObjects.Codegen", "Generators");

    [Fact]
    public void Every_ejectable_entry_has_a_source_file_name()
    {
        var entries = EjectableGenerators.Entries();
        Assert.NotEmpty(entries);
        Assert.All(entries, e => Assert.False(string.IsNullOrEmpty(e.SourceFileName)));
    }

    [Fact]
    public void Embedded_copies_are_byte_identical_to_their_source_files()
    {
        // The generators AND the emitters handed over with them: every path any entry hands over.
        var packageDir = Path.Combine(CorpusPaths.RepoRoot(), "server", "csharp", "MetaObjects.Codegen");
        foreach (var sourcePath in EjectableGenerators.AllSourcePaths())
        {
            var embedded = EjectableGenerators.ReadSourcePath(sourcePath);
            var onDisk = File.ReadAllText(Path.Combine(packageDir, sourcePath));
            Assert.True(
                Normalize(embedded) == Normalize(onDisk),
                $"embedded {sourcePath} diverges from its source file — " +
                "rebuild MetaObjects.Codegen after editing the generator.");
        }
    }

    [Fact]
    public void Embedded_resource_set_matches_what_the_registry_hands_over_exactly()
    {
        // Every source file eject hands over — each entry's SourceFileName and its Companions — is
        // an embedded resource, and nothing else under Generators/, Docs/ or ApiDocs/ is.
        var asm = typeof(EjectableGenerators).Assembly;
        var embedded = asm.GetManifestResourceNames()
            .Where(n => EjectableGenerators.SourceDirectories.Any(d =>
                n.StartsWith($"MetaObjects.Codegen.{d}.", StringComparison.Ordinal)))
            .OrderBy(n => n, StringComparer.Ordinal)
            .ToList();
        var handedOver = EjectableGenerators.AllSourcePaths()
            .Select(EjectableGenerators.ResourceName)
            .OrderBy(n => n, StringComparer.Ordinal)
            .ToList();
        Assert.Equal(handedOver, embedded);
    }

    [Fact]
    public void Every_companion_is_a_file_the_package_ships_and_no_two_files_share_a_name()
    {
        // Owned copies are written flat, into codegen/generators/, so a name two source directories share
        // would make eject overwrite one with the other.
        var packageDir = Path.Combine(CorpusPaths.RepoRoot(), "server", "csharp", "MetaObjects.Codegen");
        var all = EjectableGenerators.AllSourcePaths();
        Assert.All(all, p => Assert.True(File.Exists(Path.Combine(packageDir, p)), $"{p} does not exist"));
        Assert.Equal(all.Count, all.Select(p => p[(p.LastIndexOf('/') + 1)..]).Distinct(StringComparer.Ordinal).Count());
    }

    [Fact]
    public void Ownership_is_one_flat_directory_whichever_package_directory_a_file_came_from()
    {
        Assert.Equal("codegen/generators/EntityGenerator.cs", EjectableGenerators.OwnedRelativePath("Generators/EntityGenerator.cs"));
        Assert.Equal("codegen/generators/XmlDocBuilder.cs", EjectableGenerators.OwnedRelativePath("Docs/XmlDocBuilder.cs"));
        Assert.Equal("codegen/generators/DocsPaths.cs", EjectableGenerators.OwnedRelativePath("ApiDocs/DocsPaths.cs"));
    }

    [Fact]
    public void Requirement_tests_is_ejectable_and_its_source_is_one_file_in_the_packaged_namespace()
    {
        var entry = Assert.Single(EjectableGenerators.Entries(), e => e.Name == "requirement-tests");
        Assert.Equal("RequirementTestsGenerator.cs", entry.SourceFileName);
        var source = EjectableGenerators.ReadSource("requirement-tests")!;
        Assert.Contains("namespace MetaObjects.Codegen.Generators;", source);
        Assert.Contains("class RequirementTestsGenerator", source);
        // The default rendering lives in this one file, so one eject takes the generator and its renderer together.
        Assert.Contains("DefaultTest(", source);
        Assert.Contains("WitnessInterface(", source);
    }

    [Fact]
    public void ReadSource_resolves_by_stable_registry_name()
    {
        var text = EjectableGenerators.ReadSource("entity");
        Assert.NotNull(text);
        Assert.Contains("class EntityGenerator", text);
    }

    [Fact]
    public void ReadSource_returns_null_for_an_unknown_or_non_ejectable_name()
    {
        Assert.Null(EjectableGenerators.ReadSource("no-such-generator"));
        Assert.Null(EjectableGenerators.ReadSource("template"));
    }

    [Fact]
    public void RewriteForEject_renames_the_namespace_and_adds_the_two_usings_it_replaces()
    {
        const string src =
            "using System.Text;\n" +
            "using MetaObjects.Meta;\n" +
            "\n" +
            "namespace MetaObjects.Codegen.Generators;\n" +
            "\n" +
            "public class EntityGenerator : IGenerator\n" +
            "{\n" +
            "}\n";

        var rewritten = EjectableGenerators.RewriteForEject(src);

        Assert.Contains("namespace Codegen.Generators;", rewritten);
        Assert.DoesNotContain("namespace MetaObjects.Codegen.Generators;", rewritten);
        Assert.Contains("using MetaObjects.Codegen;", rewritten);
        Assert.Contains("using MetaObjects.Codegen.Generators;", rewritten);
        // Everything else is untouched — the class body survives verbatim.
        Assert.Contains("public class EntityGenerator : IGenerator", rewritten);
    }

    [Fact]
    public void RewriteForEject_runs_clean_on_every_real_ejectable_source()
    {
        // Every real embedded source actually contains the line being rewritten — this
        // would fail loudly (not silently) if a file's namespace declaration ever changed
        // shape — and every one lands in the owned namespace, whichever package directory it came from.
        foreach (var sourcePath in EjectableGenerators.AllSourcePaths())
        {
            var rewritten = EjectableGenerators.RewriteForEject(EjectableGenerators.ReadSourcePath(sourcePath));
            Assert.Contains("namespace Codegen.Generators;", rewritten);
            Assert.DoesNotContain("namespace MetaObjects.Codegen.", rewritten);
            Assert.DoesNotContain("using MetaObjects.Codegen.Docs;", rewritten);
            Assert.DoesNotContain("using MetaObjects.Codegen.ApiDocs;", rewritten);
        }
    }

    [Fact]
    public void RewriteForEject_adds_a_using_only_when_the_source_does_not_already_say_it()
    {
        const string src =
            "using MetaObjects.Codegen.Generators;\n" +
            "using MetaObjects.Codegen.ApiDocs;\n" +
            "\n" +
            "namespace MetaObjects.Codegen.ApiDocs;\n" +
            "\n" +
            "public sealed class Builder\n{\n}\n";

        var rewritten = EjectableGenerators.RewriteForEject(src);

        Assert.Equal(1, System.Text.RegularExpressions.Regex.Matches(rewritten, @"using MetaObjects\.Codegen\.Generators;").Count);
        Assert.DoesNotContain("using MetaObjects.Codegen.ApiDocs;", rewritten);
        Assert.Contains("namespace Codegen.Generators;", rewritten);
    }

    private static string Normalize(string s) => s.Replace("\r\n", "\n");
}
