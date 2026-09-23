// ADR-0034 Amendment 3 — eject. `EjectableGenerators` is the embedded-resource surface
// `dotnet meta eject` reads from (never the file on disk — the tool ships compiled, so
// there is no source tree beside it). These tests gate the two things that would let a
// packaged generator silently diverge from what `eject` hands an adopter:
//   1. the embedded copy is byte-identical to its Generators/<file> source (drift gate);
//   2. the embedded RESOURCE SET matches exactly the registry's ejectable entries (so a
//      new ejectable generator can't ship without its embed, and vice versa).
// Also covers the one deliberate edit `RewriteForEject` makes (the namespace rename —
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
    public void Template_primitive_is_not_ejectable()
    {
        // ADR-0034 Amendment 3 (C# section): "template" has no emit logic of its own to
        // own, so it carries no SourceFileName and must not appear in the ejectable set.
        Assert.DoesNotContain(EjectableGenerators.Entries(), e => e.Name == "template");
    }

    [Fact]
    public void Embedded_copies_are_byte_identical_to_their_source_files()
    {
        var dir = GeneratorsDir();
        foreach (var entry in EjectableGenerators.Entries())
        {
            var embedded = EjectableGenerators.ReadSourceFile(entry.SourceFileName!);
            var onDisk = File.ReadAllText(Path.Combine(dir, entry.SourceFileName!));
            Assert.True(
                Normalize(embedded) == Normalize(onDisk),
                $"embedded Generators/{entry.SourceFileName} diverges from its source file — " +
                "rebuild MetaObjects.Codegen after editing the generator.");
        }
    }

    [Fact]
    public void Embedded_resource_set_matches_the_registry_ejectable_set_exactly()
    {
        var asm = typeof(EjectableGenerators).Assembly;
        var embeddedNames = asm.GetManifestResourceNames()
            .Where(n => n.StartsWith(EjectableGenerators.ResourcePrefix, StringComparison.Ordinal))
            .Select(n => n[EjectableGenerators.ResourcePrefix.Length..])
            .OrderBy(n => n, StringComparer.Ordinal)
            .ToList();
        var registryNames = EjectableGenerators.Entries()
            .Select(e => e.SourceFileName!)
            .OrderBy(n => n, StringComparer.Ordinal)
            .ToList();
        Assert.Equal(registryNames, embeddedNames);
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
        // would fail loudly (not silently) if a generator file's namespace declaration
        // ever changed shape.
        foreach (var entry in EjectableGenerators.Entries())
        {
            var source = EjectableGenerators.ReadSourceFile(entry.SourceFileName!);
            var rewritten = EjectableGenerators.RewriteForEject(source);
            Assert.Contains("namespace Codegen.Generators;", rewritten);
        }
    }

    private static string Normalize(string s) => s.Replace("\r\n", "\n");
}
