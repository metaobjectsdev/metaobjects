// ADR-0034 Amendment 3 — the helper runtime `dotnet meta eject routes` hands over with the
// generator (MetaObjects.Codegen.HelperRuntime). These tests gate:
//   1. the embedded copies are byte-identical to Runtime/<file> and match HelperRuntime.Files;
//   2. every Runtime/ file is classified helper (copied) or core (stays in the package);
//   3. the helper set is CLOSED — it compiles on its own, with no MetaObjects assembly;
//   4. an ejected routes generator's output compiles against the OWNED copy with no
//      MetaObjects assembly referenced at all, and binds to that copy: break the copy and
//      the generated routes stop compiling.

using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using MetaObjects.Codegen.Generators;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public class HelperRuntimeTests
{
    private static string RuntimeDir() =>
        Path.Combine(CorpusPaths.RepoRoot(), "server", "csharp", "MetaObjects.Codegen", "Runtime");

    private static string Normalize(string s) => s.Replace("\r\n", "\n");

    [Fact]
    public void Embedded_copies_are_byte_identical_to_their_source_files()
    {
        foreach (var file in HelperRuntime.Files)
            Assert.True(
                Normalize(HelperRuntime.ReadSourceFile(file)) == Normalize(File.ReadAllText(Path.Combine(RuntimeDir(), file))),
                $"embedded Runtime/{file} diverges from its source file — rebuild MetaObjects.Codegen.");
    }

    [Fact]
    public void Embedded_resource_set_matches_HelperRuntime_Files_exactly()
    {
        var embedded = typeof(HelperRuntime).Assembly.GetManifestResourceNames()
            .Where(n => n.StartsWith(HelperRuntime.ResourcePrefix, StringComparison.Ordinal))
            .Select(n => n[HelperRuntime.ResourcePrefix.Length..])
            .OrderBy(n => n, StringComparer.Ordinal);
        Assert.Equal(HelperRuntime.Files.OrderBy(n => n, StringComparer.Ordinal), embedded);
    }

    [Fact]
    public void Every_runtime_file_is_classified_helper_or_core_and_never_both()
    {
        // A new Runtime/ file must be put on one side of the line on purpose: copied to an
        // adopter who ejects, or kept in the package as core.
        var onDisk = Directory.GetFiles(RuntimeDir(), "*.cs").Select(Path.GetFileName).OrderBy(n => n, StringComparer.Ordinal);
        var classified = HelperRuntime.Files.Concat(HelperRuntime.CoreFiles).OrderBy(n => n, StringComparer.Ordinal);
        Assert.Equal(classified, onDisk);
        Assert.Empty(HelperRuntime.Files.Intersect(HelperRuntime.CoreFiles));
    }

    [Fact]
    public void RewriteForEject_moves_only_the_namespace()
    {
        foreach (var file in HelperRuntime.Files)
        {
            var packaged = HelperRuntime.ReadSourceFile(file);
            var owned = HelperRuntime.OwnedReference(file);
            Assert.Contains($"namespace {HelperRuntime.OwnedNamespace};", owned);
            Assert.DoesNotContain($"namespace {HelperRuntime.PackagedNamespace};", owned);
            Assert.Equal(
                packaged.Replace($"namespace {HelperRuntime.PackagedNamespace};", $"namespace {HelperRuntime.OwnedNamespace};"),
                owned);
        }
    }

    [Fact]
    public void Only_generators_whose_output_imports_the_runtime_carry_the_marker()
    {
        var users = EjectableGenerators.Entries()
            .Where(e => HelperRuntime.UsedBy(EjectableGenerators.ReadSourceFile(e.SourceFileName!)))
            .Select(e => e.Name)
            .ToList();
        Assert.Equal(["routes"], users);

        var rewritten = EjectableGenerators.RewriteForEject(EjectableGenerators.ReadSource("routes")!);
        Assert.DoesNotContain(HelperRuntime.GeneratorMarkerLine, rewritten);
        Assert.Contains($"HelperRuntimeNamespace = \"{HelperRuntime.OwnedNamespace}\";", rewritten);
    }

    /// <summary>
    /// BCL + EF Core + the ASP.NET Core shared framework — what an adopter's web project
    /// compiles with — and deliberately NO MetaObjects assembly. The test host's trusted
    /// platform list carries this project's own dependencies, MetaObjects.* included, so
    /// they are filtered out by name.
    /// </summary>
    internal static List<MetadataReference> ReferencesWithoutMetaObjects()
    {
        var paths = DbContextCompileTests.BuildReferences()
            .OfType<PortableExecutableReference>()
            .Select(r => r.FilePath!)
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        var aspNetDir = Path.GetDirectoryName(typeof(Microsoft.AspNetCore.Http.IQueryCollection).Assembly.Location)!;
        foreach (var dll in Directory.GetFiles(aspNetDir, "*.dll")) paths.Add(dll);
        paths.Add(typeof(Microsoft.AspNetCore.Builder.WebApplication).Assembly.Location);
        paths.Add(typeof(Microsoft.AspNetCore.Http.Results).Assembly.Location);

        return paths
            .Where(p => !Path.GetFileName(p).StartsWith("MetaObjects", StringComparison.OrdinalIgnoreCase))
            .Where(File.Exists)
            .Select(p => (MetadataReference)MetadataReference.CreateFromFile(p))
            .ToList();
    }

    private static List<string> CompileErrors(IEnumerable<(string Path, string Content)> sources)
    {
        var trees = sources
            .Select(s => CSharpSyntaxTree.ParseText(s.Content, new CSharpParseOptions(LanguageVersion.CSharp12), path: s.Path))
            .ToList();
        var comp = CSharpCompilation.Create(
            "helper_runtime_" + Guid.NewGuid().ToString("N"), trees, ReferencesWithoutMetaObjects(),
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary, nullableContextOptions: NullableContextOptions.Enable));
        return comp.GetDiagnostics()
            .Where(d => d.Severity == DiagnosticSeverity.Error)
            .Select(d =>
            {
                var span = d.Location.GetLineSpan();
                return $"{span.Path}:{span.StartLinePosition.Line + 1} {d.Id}: {d.GetMessage()}";
            })
            .ToList();
    }

    // The SDK's implicit global usings for an adopter's project (ImplicitUsings=enable),
    // which the owned runtime files rely on exactly as the package's own build does.
    private const string ImplicitUsings =
        "global using global::System;\n" +
        "global using global::System.Collections.Generic;\n" +
        "global using global::System.IO;\n" +
        "global using global::System.Linq;\n" +
        "global using global::System.Threading;\n" +
        "global using global::System.Threading.Tasks;\n";

    private static IEnumerable<(string, string)> OwnedRuntime(Func<string, string, string>? edit = null) =>
        HelperRuntime.Files.Select(f =>
            ($"{HelperRuntime.OwnedDirectory}/{f}", edit is null ? HelperRuntime.OwnedReference(f) : edit(f, HelperRuntime.OwnedReference(f))));

    [Fact]
    public void The_helper_set_is_closed_and_compiles_without_any_MetaObjects_assembly()
    {
        var errors = CompileErrors(OwnedRuntime().Append(("GlobalUsings.g.cs", ImplicitUsings)));
        Assert.True(errors.Count == 0,
            "the owned helper runtime does not compile on its own — it depends on something eject " +
            "does not hand over:\n" + string.Join("\n", errors));
    }

    /// <summary>What an adopter who ejected routes generates: the packaged entity /
    /// db-context / filter-allowlist / names output plus the OWNED routes copy's output.</summary>
    private static List<EmittedFile> GenerateWithEjectedRoutes()
    {
        var root = EjectedGeneratorCompileTests.LoadCorpus();
        var ctx = new GenContext
        {
            Entities = root.Objects(),
            Root = root,
            Config = new GenConfig { OutDir = "/tmp", Namespace = "Acme.Generated", IncludeNames = true },
        };
        var ownedRoutes = EjectedGeneratorCompileTests.CompileAndInstantiate("routes", "RoutesGenerator", []);
        var generators = new List<IGenerator>
        {
            new EntityGenerator(), new DbContextGenerator(), new FilterAllowlistGenerator(), new NamesGenerator(), ownedRoutes,
        };
        return generators.SelectMany(g => g.Generate(ctx)).ToList();
    }

    [Fact]
    public void Ejected_routes_output_compiles_against_the_owned_runtime_with_no_MetaObjects_reference()
    {
        var files = GenerateWithEjectedRoutes();
        var routes = files.Where(f => f.Path.EndsWith("Routes.cs", StringComparison.Ordinal) || f.Content.Contains("MapGet(")).ToList();
        Assert.NotEmpty(routes);
        Assert.All(routes, f =>
        {
            Assert.Contains($"using {HelperRuntime.OwnedNamespace};", f.Content);
            Assert.DoesNotContain(HelperRuntime.PackagedNamespace, f.Content);
        });
        Assert.DoesNotContain(files, f => f.Content.Contains("MetaObjects.Codegen", StringComparison.Ordinal));

        var errors = CompileErrors(
            files.Select(f => (f.Path, f.Content)).Concat(OwnedRuntime()).Append(("GlobalUsings.g.cs", ImplicitUsings)));
        Assert.True(errors.Count == 0,
            $"ejected routes output + owned runtime failed to compile with no MetaObjects assembly " +
            $"({errors.Count} error(s)):\n" + string.Join("\n", errors.Take(40)));
    }

    [Fact]
    public void Generated_routes_bind_to_the_owned_copy_an_edit_there_is_what_they_compile_against()
    {
        // Rename the owned FilterParser.Parse. If the generated routes bound to anything but
        // the owned copy (the package, say), this would not touch them; instead every list
        // handler stops compiling, at the call site in the generated routes file.
        var files = GenerateWithEjectedRoutes();
        var edited = OwnedRuntime((file, text) => file == "FilterParser.cs"
            ? text.Replace("public static FilterParseResult Parse(", "public static FilterParseResult ParseEdited(", StringComparison.Ordinal)
            : text);
        var errors = CompileErrors(
            files.Select(f => (f.Path, f.Content)).Concat(edited).Append(("GlobalUsings.g.cs", ImplicitUsings)));

        Assert.NotEmpty(errors);
        Assert.All(errors, e => Assert.Contains("FilterParser", e));
        Assert.Contains(errors, e => e.Contains("Routes", StringComparison.Ordinal));
    }
}
