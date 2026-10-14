// ADR-0034 Amendment 9 — one way to generate. The project's generator list is
// codegen/Generators.cs; `dotnet meta gen` runs it (through the codegen project, whose entry
// point is CodegenCli.Run) and nothing else; there is no docs command; a 1.0 docs flag and a
// project with no list are refused with the amendment's fixed lines.
//
// The refusals the CLI process makes itself are driven through the built assembly
// (CliProcess). What the codegen project does with its list is driven through the same entry
// point in process (OwnedRunner).

using MetaObjects.Cli;
using MetaObjects.Codegen;
using MetaObjects.Codegen.Generators;
using Xunit;

namespace MetaObjects.Cli.Tests;

[Collection(OwnedRunnerCollection.Name)]
public sealed class OneGeneratorListTests : IDisposable
{
    private readonly string _tmp = Path.Combine(Path.GetTempPath(), "meta-one-list-" + Guid.NewGuid().ToString("N"));
    private string MetaDir => Path.Combine(_tmp, "metaobjects");
    private string OutDir => Path.Combine(_tmp, "generated");
    private string DocsDir => Path.Combine(_tmp, "docs");

    private const string Metadata = """
    { "metadata.root": { "package": "acme", "children": [
      { "object.entity": { "name": "Subscriber", "children": [
        { "source.rdb": { "@table": "subscribers" } },
        { "field.long":   { "name": "id" } },
        { "field.string": { "name": "email", "@required": true } },
        { "identity.primary": { "@fields": "id" } }
      ]}}
    ]}}
    """;

    public OneGeneratorListTests()
    {
        Directory.CreateDirectory(MetaDir);
        File.WriteAllText(Path.Combine(MetaDir, "meta.acme.json"), Metadata);
    }

    public void Dispose() { try { Directory.Delete(_tmp, recursive: true); } catch { } }

    /// <summary>Every file under the project, project-relative, sorted.</summary>
    private IReadOnlyList<string> ProjectFiles() =>
        [.. Directory.GetFiles(_tmp, "*", SearchOption.AllDirectories)
            .Select(f => Path.GetRelativePath(_tmp, f).Replace(Path.DirectorySeparatorChar, '/'))
            .Order(StringComparer.Ordinal)];

    private static IReadOnlyList<string> FilesUnder(string dir) =>
        Directory.Exists(dir)
            ? [.. Directory.GetFiles(dir, "*", SearchOption.AllDirectories)
                .Select(f => Path.GetRelativePath(dir, f).Replace(Path.DirectorySeparatorChar, '/'))
                .Order(StringComparer.Ordinal)]
            : [];

    // ---- a list that declares nothing writes nothing ------------------------------------------

    [Fact]
    public void A_list_that_declares_nothing_writes_zero_files_and_says_so()
    {
        var before = ProjectFiles();

        var (exit, stdout, stderr) = OwnedRunner.Run(_tmp, Array.Empty<IGenerator>(), "gen", MetaDir, "--out", OutDir);

        Assert.True(exit == 0, $"exit={exit}\nstdout={stdout}\nstderr={stderr}");
        Assert.Contains("dotnet meta gen: codegen/Generators.cs declares no generators; nothing written", stdout);
        Assert.Empty(FilesUnder(OutDir));
        Assert.Equal(before, ProjectFiles());
    }

    // ---- one listed generator writes only its own files ---------------------------------------

    [Fact]
    public void One_listed_docs_generator_writes_only_its_pages_in_its_own_directory()
    {
        var (exit, stdout, stderr) = OwnedRunner.Run(
            _tmp, [new ApiDocsGenerator { OutDir = DocsDir, ProjectName = "acme" }], "gen", MetaDir, "--out", OutDir);

        Assert.True(exit == 0, $"exit={exit}\nstdout={stdout}\nstderr={stderr}");
        var pages = FilesUnder(DocsDir);
        Assert.Contains("api/csharp/README.md", pages);
        Assert.Contains("api/csharp/AGENT-API.md", pages);
        Assert.Contains("api/csharp/acme/Subscriber.md", pages);
        Assert.All(pages, p => Assert.StartsWith("api/csharp/", p));
        Assert.Empty(FilesUnder(OutDir));
    }

    [Fact]
    public void One_listed_code_generator_writes_only_its_own_files()
    {
        var (exit, stdout, stderr) = OwnedRunner.Run(_tmp, ["entity"], "gen", MetaDir, "--out", OutDir);

        Assert.True(exit == 0, $"exit={exit}\nstdout={stdout}\nstderr={stderr}");
        Assert.Equal(["Subscriber.g.cs"], FilesUnder(OutDir));
        Assert.False(Directory.Exists(DocsDir));
    }

    // ---- --generators narrows the declared list and never adds to it --------------------------

    [Fact]
    public void A_selection_naming_an_undeclared_generator_is_refused_and_writes_nothing()
    {
        var (exit, _, stderr) = OwnedRunner.Run(
            _tmp, ["entity"], "gen", MetaDir, "--out", OutDir, "--generators", "entity,names");

        Assert.Equal(2, exit);
        Assert.Contains("--generators names \"names\", which codegen/Generators.cs does not declare", stderr);
        Assert.Empty(FilesUnder(OutDir));
    }

    [Fact]
    public void A_selection_runs_only_the_declared_entries_it_names()
    {
        var (exit, stdout, stderr) = OwnedRunner.Run(
            _tmp, [new EntityGenerator(), new NamesGenerator(), new ApiDocsGenerator { OutDir = DocsDir }],
            "gen", MetaDir, "--out", OutDir, "--generators", "names");

        Assert.True(exit == 0, $"exit={exit}\nstdout={stdout}\nstderr={stderr}");
        Assert.Equal(["SubscriberNames.g.cs"], FilesUnder(OutDir));
        Assert.False(Directory.Exists(DocsDir));
    }

    [Fact]
    public void A_selection_matches_an_entry_by_its_registry_name()
    {
        // `entity` builds a generator named `entity-generator`; an owned copy keeps that name.
        Assert.NotEqual("entity", new EntityGenerator().Name);
        IReadOnlyList<IGenerator> declared = [new EntityGenerator(), new NamesGenerator()];

        var selected = CodegenCli.SelectDeclared(declared, ["entity"], "templates", out var error);

        Assert.Null(error);
        Assert.Same(declared[0], Assert.Single(selected));
    }

    // ---- the docs command is removed ------------------------------------------------------------

    [Fact]
    public void The_docs_command_prints_the_removal_line_and_exits_2()
    {
        var (exit, stdout, stderr) = CliProcess.Run(_tmp, "docs", MetaDir, "--out", DocsDir);

        Assert.Equal(2, exit);
        Assert.Equal(CodegenCli.DocsCommandRemoved, stderr.Trim());
        Assert.Equal("", stdout);
        Assert.False(Directory.Exists(DocsDir));
        Assert.Equal(
            "dotnet meta docs was removed in 1.1.0. `dotnet meta gen` writes documentation now: declare each docs " +
            "generator in codegen/Generators.cs. See docs/features/migrations/docs-are-generators.md, section \"C#\".",
            CodegenCli.DocsCommandRemoved);
    }

    [Fact]
    public void The_codegen_projects_docs_command_prints_the_same_line()
    {
        var (exit, _, stderr) = OwnedRunner.Run(_tmp, ["entity"], "docs", MetaDir, "--out", DocsDir);

        Assert.Equal(2, exit);
        Assert.Equal(CodegenCli.DocsCommandRemoved, stderr.Trim());
        Assert.False(Directory.Exists(DocsDir));
    }

    // ---- a 1.0-shape gen is refused before it writes anything ---------------------------------

    private static readonly string LegacyLine =
        "dotnet meta gen: found 1.0 docs configuration (--project, --model-base-url). Nothing reads it any more, " +
        "so this run would write no documentation. Declare each docs generator in codegen/Generators.cs. See " +
        "docs/features/migrations/docs-are-generators.md, section \"C#\".";

    [Fact]
    public void Gen_given_1_0_docs_flags_prints_the_amendment_line_and_writes_nothing()
    {
        Assert.Equal(LegacyLine, CodegenCli.LegacyDocsConfiguration("dotnet meta gen", ["--project", "--model-base-url"]));

        var (exit, _, stderr) = CliProcess.Run(
            _tmp, "gen", MetaDir, "--out", OutDir, "--project", "p", "--model-base-url", "https://x.example/model");

        Assert.Equal(2, exit);
        Assert.Equal(LegacyLine, stderr.Trim());
        Assert.Empty(FilesUnder(OutDir));
    }

    [Fact]
    public void The_codegen_project_refuses_1_0_docs_flags_the_same_way()
    {
        var (exit, _, stderr) = OwnedRunner.Run(
            _tmp, ["entity"], "gen", MetaDir, "--out", OutDir, "--project", "p", "--model-base-url", "https://x.example/model");

        Assert.Equal(2, exit);
        Assert.Equal(LegacyLine, stderr.Trim());
        Assert.Empty(FilesUnder(OutDir));
    }

    // ---- a project with no list is refused ------------------------------------------------------

    [Fact]
    public void Gen_in_a_project_with_no_generator_list_prints_the_amendment_line()
    {
        var (exit, _, stderr) = CliProcess.Run(_tmp, "gen", MetaDir, "--out", OutDir);

        Assert.Equal(2, exit);
        Assert.Equal(
            "dotnet meta gen: no codegen/Generators.cs. The generator list lives there in 1.1.0, documentation " +
            "included; `dotnet meta init` writes it. See docs/features/migrations/docs-are-generators.md, section \"C#\".",
            stderr.Trim());
        Assert.Equal(CodegenCli.NoGeneratorList("dotnet meta gen"), stderr.Trim());
        Assert.Empty(FilesUnder(OutDir));
    }

    [Fact]
    public void Verify_codegen_in_a_project_with_no_generator_list_prints_the_amendment_line()
    {
        var (exit, _, stderr) = CliProcess.Run(_tmp, "verify", MetaDir, "--codegen", "--out", OutDir);

        Assert.Equal(2, exit);
        Assert.Contains(CodegenCli.NoGeneratorList("dotnet meta verify --codegen"), stderr);
    }

    [Fact]
    public void A_list_with_no_codegen_project_to_compile_it_is_refused_with_the_fix()
    {
        Directory.CreateDirectory(Path.Combine(_tmp, "codegen"));
        File.WriteAllText(Path.Combine(_tmp, "codegen", "Generators.cs"), "// list\n");

        var (exit, _, stderr) = CliProcess.Run(_tmp, "gen", MetaDir, "--out", OutDir);

        Assert.Equal(2, exit);
        Assert.Contains("codegen/Generators.cs has no codegen/Codegen.csproj", stderr);
        Assert.Contains("`dotnet meta init`", stderr);
    }

    // ---- init and eject write the codegen project -----------------------------------------------

    [Fact]
    public void Init_writes_the_three_files_and_keeps_the_ones_that_exist()
    {
        var lines = InitCommand.Run(_tmp);

        Assert.Contains("  wrote codegen/Generators.cs", lines);
        Assert.Contains("  wrote codegen/Program.cs", lines);
        Assert.Contains("  wrote codegen/Codegen.csproj", lines);
        Assert.Equal(CodegenScaffold.ProgramCs, File.ReadAllText(Path.Combine(_tmp, "codegen", "Program.cs")));
        Assert.Equal(
            "using MetaObjects.Codegen;\nreturn CodegenCli.Run(args, Generators.All);",
            string.Join("\n", CodegenScaffold.ProgramCs.Split('\n').Where(l => l.Length > 0 && !l.StartsWith("//", StringComparison.Ordinal))));
        var list = File.ReadAllText(Path.Combine(_tmp, "codegen", "Generators.cs"));
        Assert.Equal(CodegenScaffold.GeneratorsCs([]), list);
        Assert.Contains("public static class Generators", list);
        Assert.Contains("public static IReadOnlyList<IGenerator> All { get; } =\n    [\n    ];", list);
        Assert.Contains($"Version=\"{EjectCommand.ToolVersion()}\"", File.ReadAllText(Path.Combine(_tmp, "codegen", "Codegen.csproj")));

        // A second init keeps every file, edits included.
        File.AppendAllText(Path.Combine(_tmp, "codegen", "Generators.cs"), "// mine\n");
        var again = InitCommand.Run(_tmp);
        Assert.Contains("  kept codegen/Generators.cs (already yours)", again);
        Assert.EndsWith("// mine\n", File.ReadAllText(Path.Combine(_tmp, "codegen", "Generators.cs")));
    }

    [Fact]
    public void The_init_command_writes_the_codegen_project_through_the_cli()
    {
        var (exit, stdout, _) = CliProcess.Run(_tmp, "init");

        Assert.Equal(0, exit);
        Assert.Contains("wrote codegen/Generators.cs", stdout);
        Assert.True(CodegenHandoff.HasGeneratorList(_tmp));
        Assert.True(CodegenHandoff.HasOwnedCodegen(_tmp));
    }

    [Fact]
    public void Eject_into_an_empty_project_lists_the_ejected_generator()
    {
        var outcome = EjectCommand.Run(["entity"], _tmp, force: false);

        Assert.Equal(0, outcome.ExitCode);
        foreach (var file in CodegenScaffold.Files)
            Assert.True(File.Exists(Path.Combine(_tmp, file)), file);
        Assert.Equal(
            CodegenScaffold.GeneratorsCs(["new Codegen.Generators.EntityGenerator()"]),
            File.ReadAllText(Path.Combine(_tmp, "codegen", "Generators.cs")));
        Assert.Equal(CodegenScaffold.ProgramCs, File.ReadAllText(Path.Combine(_tmp, "codegen", "Program.cs")));
    }
}
