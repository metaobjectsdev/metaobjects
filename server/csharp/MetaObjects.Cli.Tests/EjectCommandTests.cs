// ADR-0034 Amendment 3 — `dotnet meta eject <name>...`. Mirrors the TypeScript
// `meta eject` / Python `metaobjects eject` contract: copy is verbatim (module the one
// namespace edit `EjectableGenerators.RewriteForEject` makes), never overwrite without
// --force, check every name before writing anything, report — never edit — the wiring.

using MetaObjects.Cli;
using MetaObjects.Codegen;
using Xunit;

namespace MetaObjects.Cli.Tests;

public sealed class EjectCommandTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "meta-eject-" + Guid.NewGuid().ToString("N"));
    private string CodegenDir => Path.Combine(_root, "codegen");
    private string GeneratorsDir => Path.Combine(CodegenDir, "generators");

    public EjectCommandTests() => Directory.CreateDirectory(_root);
    public void Dispose() { try { Directory.Delete(_root, recursive: true); } catch { } }

    // The scaffold pins MetaObjects.Codegen to the version that is actually PUBLISHED, which
    // for a release candidate carries its prerelease suffix. Pinning the bare
    // AssemblyVersion (1.0.5 for 1.0.5-rc.3) points an RC user at a package that does not
    // exist yet, so `dotnet run --project codegen` fails at restore.
    [Theory]
    [InlineData("1.0.5-rc.3+8ef72c361abc", "1.0.5.0", "1.0.5-rc.3")]
    [InlineData("1.0.5", "1.0.5.0", "1.0.5")]
    [InlineData("1.0.5+8ef72c361abc", "1.0.5.0", "1.0.5")]
    [InlineData(null, "1.0.5.0", "1.0.5")]
    [InlineData("", null, "1.0.0")]
    public void Scaffold_pins_the_published_package_version(string? informational, string? assembly, string expected)
    {
        var version = EjectCommand.PackageVersion(informational, assembly is null ? null : Version.Parse(assembly));

        Assert.Equal(expected, version);
    }

    [Fact]
    public void Unknown_name_exits_2_and_writes_nothing()
    {
        var result = EjectCommand.Run(["no-such-generator"], _root, force: false);

        Assert.Equal(2, result.ExitCode);
        Assert.False(Directory.Exists(CodegenDir));
    }

    [Fact]
    public void Unknown_name_among_known_ones_writes_NOTHING_all_or_nothing()
    {
        var result = EjectCommand.Run(["entity", "no-such-generator"], _root, force: false);

        Assert.Equal(2, result.ExitCode);
        Assert.False(File.Exists(Path.Combine(GeneratorsDir, "EntityGenerator.cs")));
    }

    [Fact]
    public void No_names_and_no_list_is_a_usage_error()
    {
        var result = EjectCommand.Run([], _root, force: false);
        Assert.Equal(2, result.ExitCode);
    }

    [Fact]
    public void Template_is_not_ejectable()
    {
        var result = EjectCommand.Run(["template"], _root, force: false);
        Assert.Equal(2, result.ExitCode);
    }

    [Fact]
    public void Ejecting_a_known_generator_writes_the_rewritten_copy_and_the_scaffold()
    {
        var result = EjectCommand.Run(["entity"], _root, force: false);

        Assert.Equal(0, result.ExitCode);
        var copyPath = Path.Combine(GeneratorsDir, "EntityGenerator.cs");
        Assert.True(File.Exists(copyPath));
        var text = File.ReadAllText(copyPath);
        Assert.Contains("namespace Codegen.Generators;", text);
        Assert.DoesNotContain("namespace MetaObjects.Codegen.Generators;", text);

        Assert.True(File.Exists(Path.Combine(CodegenDir, "Codegen.csproj")));
        Assert.True(File.Exists(Path.Combine(CodegenDir, "Program.cs")));
        Assert.True(File.Exists(Path.Combine(CodegenDir, "Generators.cs")));
        var csproj = File.ReadAllText(Path.Combine(CodegenDir, "Codegen.csproj"));
        Assert.Contains("MetaObjects.Codegen", csproj);
        // ADR-0034 Amendment 9: the list is Generators.cs; Program.cs is the two-line entry that runs it.
        Assert.Equal(CodegenScaffold.ProgramCs, File.ReadAllText(Path.Combine(CodegenDir, "Program.cs")));
        var list = File.ReadAllText(Path.Combine(CodegenDir, "Generators.cs"));
        Assert.Contains("        new Codegen.Generators.EntityGenerator(),\n", list);
        Assert.Equal(CodegenScaffold.GeneratorsCs(["new Codegen.Generators.EntityGenerator()"]), list);
    }

    [Fact]
    public void Ejecting_twice_without_force_preserves_the_existing_copy()
    {
        EjectCommand.Run(["entity"], _root, force: false);
        var copyPath = Path.Combine(GeneratorsDir, "EntityGenerator.cs");
        File.AppendAllText(copyPath, "\n// hand edit\n");
        var before = File.ReadAllText(copyPath);

        var result = EjectCommand.Run(["entity"], _root, force: false);

        Assert.Equal(1, result.ExitCode);
        Assert.Equal(before, File.ReadAllText(copyPath));
    }

    [Fact]
    public void Force_replaces_an_edited_copy()
    {
        EjectCommand.Run(["entity"], _root, force: false);
        var copyPath = Path.Combine(GeneratorsDir, "EntityGenerator.cs");
        File.AppendAllText(copyPath, "\n// hand edit\n");

        var result = EjectCommand.Run(["entity"], _root, force: true);

        Assert.Equal(0, result.ExitCode);
        Assert.DoesNotContain("hand edit", File.ReadAllText(copyPath));
    }

    [Fact]
    public void A_second_eject_of_a_different_generator_does_not_touch_the_existing_scaffold()
    {
        EjectCommand.Run(["entity"], _root, force: false);
        // Hand-edit Program.cs and the list the way an adopter would — eject must never clobber either.
        foreach (var file in new[] { "Program.cs", "Generators.cs" })
            File.AppendAllText(Path.Combine(CodegenDir, file), "\n// adopter's own edit\n");

        var result = EjectCommand.Run(["routes"], _root, force: false);

        Assert.Equal(0, result.ExitCode);
        Assert.True(File.Exists(Path.Combine(GeneratorsDir, "RoutesGenerator.cs")));
        Assert.Contains("adopter's own edit", File.ReadAllText(Path.Combine(CodegenDir, "Program.cs")));
        Assert.Contains("adopter's own edit", File.ReadAllText(Path.Combine(CodegenDir, "Generators.cs")));
        Assert.DoesNotContain("RoutesGenerator", File.ReadAllText(Path.Combine(CodegenDir, "Generators.cs")));
        // It prints the entry to add instead.
        Assert.Contains("  new Codegen.Generators.RoutesGenerator(),", result.Out);
    }

    [Fact]
    public void Eject_writes_each_missing_scaffold_file_and_keeps_the_ones_that_exist()
    {
        // A 1.0 project: an owned Program.cs and Codegen.csproj, no Generators.cs.
        Directory.CreateDirectory(CodegenDir);
        File.WriteAllText(Path.Combine(CodegenDir, "Program.cs"), "// 1.0 program\n");
        File.WriteAllText(Path.Combine(CodegenDir, "Codegen.csproj"), "<Project />\n");

        var result = EjectCommand.Run(["entity"], _root, force: false);

        Assert.Equal(0, result.ExitCode);
        Assert.Equal("// 1.0 program\n", File.ReadAllText(Path.Combine(CodegenDir, "Program.cs")));
        Assert.Equal("<Project />\n", File.ReadAllText(Path.Combine(CodegenDir, "Codegen.csproj")));
        Assert.Contains("new Codegen.Generators.EntityGenerator(),", File.ReadAllText(Path.Combine(CodegenDir, "Generators.cs")));
    }

    private string CsprojPath => Path.Combine(CodegenDir, "Codegen.csproj");

    /// <summary>Scaffold with this tool, then re-pin the owned project the way an older tool left it.</summary>
    private string ScaffoldPinnedAt(string? version)
    {
        Assert.Equal(0, EjectCommand.Run(["entity"], _root, force: false).ExitCode);
        var scaffolded = File.ReadAllText(CsprojPath);
        var pin = $"Version=\"{EjectCommand.ToolVersion()}\"";
        Assert.Contains(pin, scaffolded);
        if (version is not null) File.WriteAllText(CsprojPath, scaffolded.Replace(pin, $"Version=\"{version}\""));
        return File.ReadAllText(CsprojPath);
    }

    // Eject writes this tool's sources and never edits the owned project's package pin. A project
    // scaffolded by an older tool therefore gets sources its pinned package cannot compile, and the
    // only place that can say so before `dotnet run --project codegen` fails is eject's own report.
    [Fact]
    public void Ejecting_into_a_project_pinned_to_an_older_package_warns_and_names_the_line_to_change()
    {
        var csproj = ScaffoldPinnedAt("0.9.0");
        var pinLine = Array.FindIndex(csproj.Split('\n'), l => l.Contains("PackageReference", StringComparison.Ordinal)) + 1;

        var result = EjectCommand.Run(["api-docs"], _root, force: false);

        Assert.Equal(0, result.ExitCode);
        var warning = Assert.Single(result.Out, l => l.StartsWith("warning:", StringComparison.Ordinal));
        Assert.Contains("MetaObjects.Codegen 0.9.0", warning);
        Assert.Contains(EjectCommand.ToolVersion(), warning);
        Assert.Contains("will not compile", warning);
        Assert.Contains($"set the version on line {pinLine} of codegen/Codegen.csproj to {EjectCommand.ToolVersion()}", warning);
        Assert.Contains(
            $"<PackageReference Include=\"MetaObjects.Codegen\" Version=\"{EjectCommand.ToolVersion()}\" />",
            result.Out[result.Out.ToList().IndexOf(warning) + 1]);
        Assert.Equal(csproj, File.ReadAllText(CsprojPath));
    }

    // The line the warning names carries only the version in these shapes, so pasting a whole
    // PackageReference element over it would nest one inside another, or drop what else the
    // reference declares. The warning names the line and the version and prints no element.
    [Theory]
    [InlineData("<PackageReference Include=\"MetaObjects.Codegen\"\n                      Version=\"0.9.0\" />")]
    [InlineData("<PackageReference Include=\"MetaObjects.Codegen\">\n      <Version>0.9.0</Version>\n    </PackageReference>")]
    [InlineData("<PackageReference Include=\"MetaObjects.Codegen\" Version=\"0.9.0\" PrivateAssets=\"all\" />")]
    public void An_older_pin_not_in_the_scaffolded_form_is_named_by_line_and_version_only(string reference)
    {
        ScaffoldPinnedAt(null);
        var csproj =
            "<Project Sdk=\"Microsoft.NET.Sdk\">\n  <ItemGroup>\n    " + reference + "\n  </ItemGroup>\n</Project>\n";
        File.WriteAllText(CsprojPath, csproj);
        var versionLine = Array.FindIndex(csproj.Split('\n'), l => l.Contains("0.9.0", StringComparison.Ordinal)) + 1;

        var result = EjectCommand.Run(["api-docs"], _root, force: false);

        Assert.Equal(0, result.ExitCode);
        var warning = Assert.Single(result.Out, l => l.StartsWith("warning:", StringComparison.Ordinal));
        Assert.Contains($"set the version on line {versionLine} of codegen/Codegen.csproj to {EjectCommand.ToolVersion()}.", warning);
        Assert.DoesNotContain(result.Out, l => l.Contains("<PackageReference", StringComparison.Ordinal));
        Assert.Equal(csproj, File.ReadAllText(CsprojPath));
    }

    [Theory]
    [InlineData(null)]                      // the pin this tool wrote: equal
    [InlineData("99.0.0")]                  // newer
    [InlineData("$(MetaObjectsVersion)")]   // not a version eject can read
    [InlineData("[1.0.0,2.0.0)")]           // a range
    public void Ejecting_into_a_project_whose_pin_is_not_older_says_nothing_about_it(string? version)
    {
        ScaffoldPinnedAt(version);

        var result = EjectCommand.Run(["api-docs"], _root, force: false);

        Assert.Equal(0, result.ExitCode);
        Assert.DoesNotContain(result.Out, l => l.Contains("warning", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void Ejecting_into_a_project_with_no_package_pin_says_nothing_about_it()
    {
        ScaffoldPinnedAt(null);
        File.WriteAllText(CsprojPath, "<Project Sdk=\"Microsoft.NET.Sdk\"><ItemGroup><ProjectReference Include=\"../x.csproj\" /></ItemGroup></Project>");

        var result = EjectCommand.Run(["api-docs"], _root, force: false);

        Assert.Equal(0, result.ExitCode);
        Assert.DoesNotContain(result.Out, l => l.Contains("warning", StringComparison.OrdinalIgnoreCase));
    }

    // The order is semver.org's (§11), whose own worked chain is
    // 1.0.0-alpha < 1.0.0-alpha.1 < 1.0.0-alpha.beta < 1.0.0-beta.2 < 1.0.0-beta.11 < 1.0.0-rc.1 < 1.0.0.
    // A string or System.Version comparison gets the release candidate and the two-digit parts wrong.
    [Theory]
    [InlineData("1.0.13", "1.1.0", true)]
    [InlineData("1.1.0-rc.1", "1.1.0", true)]
    [InlineData("1.1.0", "1.1.0-rc.1", false)]
    [InlineData("1.1.0", "1.1.0", false)]
    [InlineData("1.1.0+8ef72c3", "1.1.0", false)]
    [InlineData("1.9.0", "1.10.0", true)]
    [InlineData("1.10.0", "1.9.0", false)]
    [InlineData("1.0.0-alpha", "1.0.0-alpha.1", true)]
    [InlineData("1.0.0-alpha.1", "1.0.0-alpha.beta", true)]
    [InlineData("1.0.0-alpha.beta", "1.0.0-beta.2", true)]
    [InlineData("1.0.0-beta.2", "1.0.0-beta.11", true)]
    [InlineData("1.0.0-beta.11", "1.0.0-rc.1", true)]
    [InlineData("1.0.0-rc.1", "1.0.0-beta.11", false)]
    [InlineData("1.*", "1.1.0", false)]
    [InlineData("$(MetaObjectsVersion)", "1.1.0", false)]
    public void A_pin_is_older_by_semantic_version_precedence(string pinned, string required, bool older)
    {
        Assert.Equal(older, EjectCommand.IsOlderVersion(pinned, required));
    }

    [Fact]
    public void Ejected_copy_is_content_identical_to_the_rewritten_reference()
    {
        EjectCommand.Run(["entity"], _root, force: false);
        var copyPath = Path.Combine(GeneratorsDir, "EntityGenerator.cs");
        var expected = EjectableGenerators.RewriteForEject(EjectableGenerators.ReadSource("entity")!);
        Assert.Equal(expected, File.ReadAllText(copyPath));
    }

    // `--list` gave stable names only, while codegen/Generators.cs holds constructed generators:
    // an adopter guessed class names and learned RenderHelperGenerator's argument from CS7036.
    [Fact]
    public void GenListLines_print_the_entry_to_put_in_the_list_and_its_options()
    {
        var lines = GenCommand.ListLines(_root);
        Assert.Contains(lines, l => l.Contains(" entity —")
            && l.Contains("\n      in codegen/Generators.cs: new MetaObjects.Codegen.Generators.EntityGenerator()"));
        var renderHelper = Assert.Single(lines, l => l.Contains(" render-helper —"));
        Assert.Contains("in codegen/Generators.cs: new MetaObjects.Codegen.Generators.RenderHelperGenerator(\"prompts\")", renderHelper);
        Assert.Contains("options: templateRoot", renderHelper);
    }

    [Fact]
    public void GenListLines_marks_an_unmodified_ejected_copy_identical()
    {
        EjectCommand.Run(["entity"], _root, force: false);

        var lines = GenCommand.ListLines(_root);
        Assert.Contains(lines, l => l.Contains(" entity —") && l.Contains("[owned — identical]")
            && l.Contains("\n      in codegen/Generators.cs: new Codegen.Generators.EntityGenerator()"));
        // Everything NOT ejected carries no ownership mark at all.
        Assert.Contains(lines, l => l.Contains(" routes —") && !l.Contains("[owned")
            && l.Contains("in codegen/Generators.cs: new MetaObjects.Codegen.Generators.RoutesGenerator()"));
    }

    // An owned generator printed the packaged class: copying that line into codegen/Generators.cs
    // wired the package back in and the owned edits silently stopped running.
    [Fact]
    public void GenListLines_print_the_owned_copy_for_an_ejected_generator_with_a_constructor_argument()
    {
        EjectCommand.Run(["render-helper"], _root, force: false);

        var renderHelper = Assert.Single(GenCommand.ListLines(_root), l => l.Contains(" render-helper —"));
        Assert.Contains("[owned — identical]", renderHelper);
        Assert.Contains("in codegen/Generators.cs: new Codegen.Generators.RenderHelperGenerator(\"prompts\")", renderHelper);
    }

    [Fact]
    public void GenListLines_marks_an_edited_ejected_copy_as_differing()
    {
        EjectCommand.Run(["entity"], _root, force: false);
        File.AppendAllText(Path.Combine(GeneratorsDir, "EntityGenerator.cs"), "\n// my own line\n");

        var lines = GenCommand.ListLines(_root);
        Assert.Contains(lines, l => l.Contains(" entity —") && l.Contains("[owned — DIFFERS:") && l.Contains("of your own]"));
    }

    // ---- The helper runtime ejecting routes hands over (MetaObjects.Codegen.HelperRuntime) ----

    private string RuntimeDir => Path.Combine(_root, "codegen", "runtime");

    [Fact]
    public void Ejecting_routes_also_copies_the_helper_runtime_under_the_owned_namespace()
    {
        var result = EjectCommand.Run(["routes"], _root, force: false);

        Assert.Equal(0, result.ExitCode);
        foreach (var file in HelperRuntime.Files)
        {
            var path = Path.Combine(RuntimeDir, file);
            Assert.True(File.Exists(path), $"expected codegen/runtime/{file}");
            var text = File.ReadAllText(path);
            Assert.Equal(HelperRuntime.OwnedReference(file), text);
            Assert.Contains("namespace Codegen.Runtime;", text);
        }
        // Core stays in the package.
        foreach (var core in HelperRuntime.CoreFiles)
            Assert.False(File.Exists(Path.Combine(RuntimeDir, core)));

        // The routes copy emits `using Codegen.Runtime;`, not the package's namespace.
        var routes = File.ReadAllText(Path.Combine(GeneratorsDir, "RoutesGenerator.cs"));
        Assert.Contains("HelperRuntimeNamespace = \"Codegen.Runtime\";", routes);
        Assert.DoesNotContain("HelperRuntimeNamespace = \"MetaObjects.Codegen.Runtime\";", routes);

        // The scaffolded codegen project does not compile the runtime into the tool.
        Assert.Contains("<Compile Remove=\"runtime/**\" />", File.ReadAllText(Path.Combine(CodegenDir, "Codegen.csproj")));
        Assert.Contains(result.Out, l => l.Contains("<Compile Include=") && l.Contains("codegen/runtime/**/*.cs"));
    }

    [Fact]
    public void Ejecting_a_generator_whose_output_uses_no_helper_runtime_copies_none()
    {
        EjectCommand.Run(["entity", "filter-allowlist", "names"], _root, force: false);
        Assert.False(Directory.Exists(RuntimeDir));
    }

    [Fact]
    public void An_existing_runtime_file_is_kept_without_force_and_replaced_with_force()
    {
        EjectCommand.Run(["routes"], _root, force: false);
        var parser = Path.Combine(RuntimeDir, "FilterParser.cs");
        File.AppendAllText(parser, "\n// my fix\n");

        // Ejecting routes again is refused (the generator copy exists) and touches nothing.
        Assert.Equal(1, EjectCommand.Run(["routes"], _root, force: false).ExitCode);
        Assert.Contains("my fix", File.ReadAllText(parser));

        var forced = EjectCommand.Run(["routes"], _root, force: true);
        Assert.Equal(0, forced.ExitCode);
        Assert.DoesNotContain("my fix", File.ReadAllText(parser));
        Assert.Contains(forced.Out, l => l.Contains("FilterParser.cs [replaced]"));
    }

    [Fact]
    public void A_runtime_copy_already_present_is_kept_when_routes_is_ejected()
    {
        // e.g. copied earlier by hand, or restored from history: eject never overwrites it.
        Directory.CreateDirectory(RuntimeDir);
        var parser = Path.Combine(RuntimeDir, "FilterParser.cs");
        File.WriteAllText(parser, "// mine\n");

        var result = EjectCommand.Run(["routes"], _root, force: false);

        Assert.Equal(0, result.ExitCode);
        Assert.Equal("// mine\n", File.ReadAllText(parser));
        Assert.Contains(result.Out, l => l.Contains("FilterParser.cs [kept"));
        Assert.True(File.Exists(Path.Combine(RuntimeDir, "EfCoreFilterDispatch.cs")));
    }

    [Fact]
    public void GenListLines_reports_the_owned_runtime_identical_then_differing()
    {
        Assert.DoesNotContain(GenCommand.ListLines(_root), l => l.Contains("codegen/runtime/"));

        EjectCommand.Run(["routes"], _root, force: false);
        Assert.Contains(GenCommand.ListLines(_root), l => l.Contains("codegen/runtime/") && l.Contains("[owned — identical]"));

        File.AppendAllText(Path.Combine(RuntimeDir, "ConstraintErrors.cs"), "\n// my own line\n");
        File.Delete(Path.Combine(RuntimeDir, "Iso8601TimestampConverter.cs"));
        var line = Assert.Single(GenCommand.ListLines(_root), l => l.Contains("codegen/runtime/"));
        Assert.Contains("ConstraintErrors.cs DIFFERS: 0 behind, 1 of your own", line);
        Assert.Contains("Iso8601TimestampConverter.cs missing", line);
        Assert.DoesNotContain("FilterParser.cs", line);
    }
}
