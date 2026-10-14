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
using MetaObjects.Codegen.TemplateCodegen;
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
    public void A_selection_writes_its_entries_as_the_whole_list_does()
    {
        IReadOnlyList<IGenerator> declared = OwnedRunner.Declared(_tmp, "entity", "names");
        Assert.Equal(0, OwnedRunner.Run(_tmp, declared, "gen", MetaDir, "--out", OutDir).ExitCode);
        var entity = Path.Combine(OutDir, "Subscriber.g.cs");
        var whole = File.ReadAllText(entity);
        Assert.Contains("SubscriberNames.", whole);

        var narrowed = OwnedRunner.Run(_tmp, declared, "gen", MetaDir, "--out", OutDir, "--generators", "entity");

        Assert.True(narrowed.ExitCode == 0, $"exit={narrowed.ExitCode}\nstdout={narrowed.Stdout}\nstderr={narrowed.Stderr}");
        Assert.Equal(whole, File.ReadAllText(entity));
        var verify = OwnedRunner.Run(_tmp, declared, "verify", MetaDir, "--codegen", "--out", OutDir, "--generators", "entity");
        Assert.True(verify.ExitCode == 0, $"exit={verify.ExitCode}\nstdout={verify.Stdout}\nstderr={verify.Stderr}");
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
            "generator in codegen/Generators.cs. See https://github.com/metaobjectsdev/metaobjects/blob/main/docs/features/migrations/docs-are-generators.md, section \"C#\".",
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
        "https://github.com/metaobjectsdev/metaobjects/blob/main/docs/features/migrations/docs-are-generators.md, section \"C#\".";

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
            "included; `dotnet meta init` writes it. See https://github.com/metaobjectsdev/metaobjects/blob/main/docs/features/migrations/docs-are-generators.md, section \"C#\".",
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
        Assert.Contains("public static IReadOnlyList<IGenerator> All { get; } = new GeneratorList\n", list);
        Assert.Contains("        // ColumnNaming = ColumnNamingStrategy.SnakeCase,\n        Entries =\n        [\n        ],\n    };", list);
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

    // ---- a 1.0 Program.cs, which never runs Generators.All, is refused --------------------------

    private const string LegacyProgramCs =
        "using MetaObjects.Codegen;\n" +
        "IReadOnlyList<IGenerator> generators = [new MetaObjects.Codegen.Generators.EntityGenerator()];\n" +
        "return CodegenCli.Run(args, generators);\n";

    /// <summary>A 1.0 codegen project upgraded half way: a Generators.cs beside the inline-list Program.cs.</summary>
    private void WriteLegacyCodegenProject(bool withGeneratorList)
    {
        Directory.CreateDirectory(Path.Combine(_tmp, "codegen"));
        File.WriteAllText(Path.Combine(_tmp, "codegen", "Program.cs"), LegacyProgramCs);
        File.WriteAllText(Path.Combine(_tmp, "codegen", "Codegen.csproj"), CodegenScaffold.Csproj());
        if (withGeneratorList)
            File.WriteAllText(Path.Combine(_tmp, "codegen", "Generators.cs"), CodegenScaffold.GeneratorsCs([]));
    }

    private static string LegacyProgramLine(string command) =>
        $"{command}: codegen/Program.cs does not run Generators.All, so it would ignore the generator list in " +
        "codegen/Generators.cs. Replace it with the two-line entry `using MetaObjects.Codegen;` and " +
        "`return CodegenCli.Run(args, Generators.All);`. See https://github.com/metaobjectsdev/metaobjects/blob/main/docs/features/migrations/docs-are-generators.md, section \"C#\".";

    [Fact]
    public void Gen_with_a_1_0_program_refuses_with_the_migration_line_and_writes_nothing()
    {
        WriteLegacyCodegenProject(withGeneratorList: true);

        var (exit, _, stderr) = CliProcess.Run(_tmp, "gen", MetaDir, "--out", OutDir);

        Assert.Equal(2, exit);
        Assert.Equal(LegacyProgramLine("dotnet meta gen"), stderr.Trim());
        Assert.Equal(CodegenCli.LegacyProgram("dotnet meta gen"), stderr.Trim());
        Assert.Empty(FilesUnder(OutDir));
    }

    [Fact]
    public void Verify_codegen_with_a_1_0_program_refuses_with_the_migration_line()
    {
        WriteLegacyCodegenProject(withGeneratorList: true);

        var (exit, _, stderr) = CliProcess.Run(_tmp, "verify", MetaDir, "--codegen", "--out", OutDir);

        Assert.Equal(2, exit);
        Assert.Contains(LegacyProgramLine("dotnet meta verify --codegen"), stderr);
    }

    [Fact]
    public void Init_beside_a_1_0_program_says_to_replace_it_instead_of_claiming_gen_runs_the_list()
    {
        WriteLegacyCodegenProject(withGeneratorList: false);

        var lines = InitCommand.Run(_tmp);

        Assert.Contains("  wrote codegen/Generators.cs", lines);
        Assert.Contains("  kept codegen/Program.cs (already yours)", lines);
        Assert.DoesNotContain(lines, l => l.Contains("is the generator list `dotnet meta gen` runs", StringComparison.Ordinal));
        Assert.Contains(lines, l => l.StartsWith("codegen/Program.cs does not run Generators.All", StringComparison.Ordinal));
        Assert.Contains("  return CodegenCli.Run(args, Generators.All);", lines);
        Assert.Contains("See https://github.com/metaobjectsdev/metaobjects/blob/main/docs/features/migrations/docs-are-generators.md, section \"C#\".", lines);
        Assert.Equal(LegacyProgramCs, File.ReadAllText(Path.Combine(_tmp, "codegen", "Program.cs")));
    }

    [Fact]
    public void Eject_beside_a_1_0_program_says_to_replace_it_instead_of_claiming_gen_runs_the_list()
    {
        WriteLegacyCodegenProject(withGeneratorList: false);

        var outcome = EjectCommand.Run(["entity"], _tmp, force: false);

        Assert.Equal(0, outcome.ExitCode);
        Assert.Contains(outcome.Out, l => l.StartsWith("codegen/Generators.cs lists the generator(s) you just ejected", StringComparison.Ordinal));
        Assert.DoesNotContain(outcome.Out, l => l.Contains("run that list", StringComparison.Ordinal));
        Assert.Contains(outcome.Out, l => l.StartsWith("codegen/Program.cs does not run Generators.All", StringComparison.Ordinal));
        Assert.Contains("  return CodegenCli.Run(args, Generators.All);", outcome.Out);
        Assert.Contains("See https://github.com/metaobjectsdev/metaobjects/blob/main/docs/features/migrations/docs-are-generators.md, section \"C#\".", outcome.Out);
        Assert.Equal(LegacyProgramCs, File.ReadAllText(Path.Combine(_tmp, "codegen", "Program.cs")));
    }

    [Fact]
    public void Init_in_a_project_pinned_to_an_older_package_warns_and_names_the_line_to_change()
    {
        WriteLegacyCodegenProject(withGeneratorList: false);
        var csprojPath = Path.Combine(_tmp, "codegen", "Codegen.csproj");
        var csproj = File.ReadAllText(csprojPath).Replace($"Version=\"{EjectCommand.ToolVersion()}\"", "Version=\"1.0.13\"");
        File.WriteAllText(csprojPath, csproj);
        var pinLine = Array.FindIndex(csproj.Split('\n'), l => l.Contains("PackageReference", StringComparison.Ordinal)) + 1;

        var lines = InitCommand.Run(_tmp);

        var warning = Assert.Single(lines, l => l.StartsWith("warning:", StringComparison.Ordinal));
        Assert.Contains("MetaObjects.Codegen 1.0.13", warning);
        Assert.Contains($"set the version on line {pinLine} of codegen/Codegen.csproj to {EjectCommand.ToolVersion()}", warning);
        Assert.Equal(csproj, File.ReadAllText(csprojPath));
    }

    [Fact]
    public void Init_in_a_project_pinned_to_this_version_does_not_warn()
    {
        WriteLegacyCodegenProject(withGeneratorList: false);

        Assert.DoesNotContain(InitCommand.Run(_tmp), l => l.StartsWith("warning:", StringComparison.Ordinal));
    }

    // ---- requirement tests go to their own directory, in the one run ---------------------------

    private const string Requirements =
        "metadata:\n  package: acme\n  children:\n" +
        "    - requirement.functional:\n        name: Subscribes\n        level: 4\n        status: live\n" +
        "        statement: A subscriber can be recorded.\n        counterexample: No subscriber is stored.\n" +
        "        implementedBy: [Subscriber]\n";

    [Fact]
    public void A_requirement_tests_entry_with_its_own_directory_is_written_and_checked_there_by_the_plain_commands()
    {
        File.WriteAllText(Path.Combine(MetaDir, "meta.requirements.yaml"), Requirements);
        var testsDir = Path.Combine(_tmp, "tests", "Acme.Shop.Tests", "Generated");
        IReadOnlyList<IGenerator> declared =
            [new EntityGenerator(), new RequirementTestsGenerator { OutDir = testsDir, WarnUncovered = false }];

        var gen = OwnedRunner.Run(_tmp, declared, "gen", MetaDir, "--out", OutDir);

        Assert.True(gen.ExitCode == 0, $"exit={gen.ExitCode}\nstdout={gen.Stdout}\nstderr={gen.Stderr}");
        Assert.Equal(["Subscriber.g.cs"], FilesUnder(OutDir));
        Assert.Equal(["Requirements_acme_Tests.g.cs", "Requirements_acme_Witnesses.g.cs"], FilesUnder(testsDir));

        var clean = OwnedRunner.Run(_tmp, declared, "verify", MetaDir, "--codegen", "--out", OutDir);
        Assert.True(clean.ExitCode == 0, $"exit={clean.ExitCode}\nstdout={clean.Stdout}\nstderr={clean.Stderr}");

        File.AppendAllText(Path.Combine(testsDir, "Requirements_acme_Tests.g.cs"), "// edited\n");
        var drift = OwnedRunner.Run(_tmp, declared, "verify", MetaDir, "--codegen", "--out", OutDir);
        Assert.Equal(1, drift.ExitCode);
        Assert.Contains("Requirements_acme_Tests.g.cs", drift.Stderr);
    }

    // ---- a narrowed verify checks only what the narrowed run produces ---------------------------

    [Fact]
    public void Verify_narrowed_to_an_entry_with_its_own_directory_does_not_convict_the_rest_of_the_list()
    {
        IReadOnlyList<IGenerator> declared = [new EntityGenerator(), new ApiDocsGenerator { OutDir = DocsDir }];
        Assert.Equal(0, OwnedRunner.Run(_tmp, declared, "gen", MetaDir, "--out", OutDir).ExitCode);

        var docsOnly = OwnedRunner.Run(_tmp, declared, "verify", MetaDir, "--codegen", "--out", OutDir, "--generators", "api-docs");
        Assert.True(docsOnly.ExitCode == 0, $"exit={docsOnly.ExitCode}\nstdout={docsOnly.Stdout}\nstderr={docsOnly.Stderr}");

        var codeOnly = OwnedRunner.Run(_tmp, declared, "verify", MetaDir, "--codegen", "--out", OutDir, "--generators", "entity");
        Assert.True(codeOnly.ExitCode == 0, $"exit={codeOnly.ExitCode}\nstdout={codeOnly.Stdout}\nstderr={codeOnly.Stderr}");

        // What the narrowed run does produce is still checked.
        File.AppendAllText(Path.Combine(DocsDir, "api", "csharp", "README.md"), "edited\n");
        var drift = OwnedRunner.Run(_tmp, declared, "verify", MetaDir, "--codegen", "--out", OutDir, "--generators", "api-docs");
        Assert.Equal(1, drift.ExitCode);
        Assert.Contains("api/csharp/README.md", drift.Stderr);
    }

    [Fact]
    public void An_entry_directory_nested_in_out_is_compared_once_as_its_own()
    {
        var nestedDocs = Path.Combine(OutDir, "docs");
        IReadOnlyList<IGenerator> declared = [new EntityGenerator(), new ApiDocsGenerator { OutDir = nestedDocs }];
        Assert.Equal(0, OwnedRunner.Run(_tmp, declared, "gen", MetaDir, "--out", OutDir).ExitCode);

        var verify = OwnedRunner.Run(_tmp, declared, "verify", MetaDir, "--codegen", "--out", OutDir);

        Assert.True(verify.ExitCode == 0, $"exit={verify.ExitCode}\nstdout={verify.Stdout}\nstderr={verify.Stderr}");
    }

    // ---- a template spec is declared in the list, nowhere else ---------------------------------

    private string WriteSpec(string fileName = CodegenCli.TemplateSpecFileName)
    {
        var templates = Path.Combine(_tmp, "templates");
        Directory.CreateDirectory(templates);
        File.WriteAllText(Path.Combine(templates, "summary.mustache"), "name={{name}}\n");
        var spec = Path.Combine(_tmp, fileName);
        File.WriteAllText(spec, """
        { "generators": [
          { "name": "summary", "template": "summary", "scope": "perEntity", "outputPattern": "{name}.summary.txt" }
        ] }
        """);
        return spec;
    }

    [Fact]
    public void A_conventional_template_spec_no_entry_declares_is_refused_and_nothing_is_written()
    {
        WriteSpec();
        var before = ProjectFiles();

        var (exit, _, stderr) = OwnedRunner.Run(_tmp, ["entity"], "gen", MetaDir, "--out", OutDir);
        Assert.Equal(2, exit);
        Assert.Equal(CodegenCli.LegacyTemplateSpec("dotnet meta gen", "template-spec.json"), stderr.Trim());
        Assert.Equal(before, ProjectFiles());

        var (verifyExit, _, verifyErr) = OwnedRunner.Run(_tmp, ["entity"], "verify", "--codegen", MetaDir, "--out", OutDir);
        Assert.Equal(2, verifyExit);
        Assert.Equal(CodegenCli.LegacyTemplateSpec("dotnet meta verify --codegen", "template-spec.json"), verifyErr.Trim());
    }

    [Fact]
    public void The_template_spec_flag_is_refused_with_the_line_that_says_where_it_went()
    {
        var spec = WriteSpec("other-spec.json");
        var before = ProjectFiles();

        var (exit, _, stderr) = OwnedRunner.Run(_tmp, ["entity"], "gen", MetaDir, "--out", OutDir, "--template-spec", spec);

        Assert.Equal(2, exit);
        Assert.Equal(CodegenCli.LegacyTemplateSpec("dotnet meta gen", "--template-spec"), stderr.Trim());
        Assert.Equal(before, ProjectFiles());
    }

    [Fact]
    public void A_declared_template_spec_entry_renders_its_templates_and_verifies_clean()
    {
        var spec = WriteSpec();
        IReadOnlyList<IGenerator> declared =
            [new TemplateSpecGenerator { Spec = spec, TemplateRoot = Path.Combine(_tmp, "templates") }];

        var (exit, stdout, stderr) = OwnedRunner.Run(_tmp, declared, "gen", MetaDir, "--out", OutDir);
        Assert.True(exit == 0, $"exit={exit}\nstdout={stdout}\nstderr={stderr}");
        Assert.Equal(["Subscriber.summary.txt"], FilesUnder(OutDir));
        Assert.Equal("name=Subscriber\n", File.ReadAllText(Path.Combine(OutDir, "Subscriber.summary.txt")));

        var (verifyExit, verifyOut, verifyErr) = OwnedRunner.Run(_tmp, declared, "verify", "--codegen", MetaDir, "--out", OutDir);
        Assert.True(verifyExit == 0, $"exit={verifyExit}\nstdout={verifyOut}\nstderr={verifyErr}");
        Assert.Contains("OK (generated output is in sync)", verifyOut);
    }

    [Fact]
    public void A_declared_template_spec_that_cannot_be_read_fails_cleanly_before_writing()
    {
        IReadOnlyList<IGenerator> declared =
            [new EntityGenerator(), new TemplateSpecGenerator { Spec = Path.Combine(_tmp, "missing.json") }];

        var (exit, _, stderr) = OwnedRunner.Run(_tmp, declared, "gen", MetaDir, "--out", OutDir);

        Assert.Equal(1, exit);
        Assert.Contains("template spec", stderr);
        Assert.Contains("missing.json", stderr);
        Assert.Empty(FilesUnder(OutDir));
    }

    [Fact]
    public void The_runs_template_root_reaches_a_declared_spec_that_names_none()
    {
        var spec = WriteSpec();
        Directory.CreateDirectory(Path.Combine(_tmp, "prompts"));
        File.WriteAllText(Path.Combine(_tmp, "prompts", "summary.mustache"), "prompt={{name}}\n");
        IReadOnlyList<IGenerator> declared = [new TemplateSpecGenerator { Spec = spec }];

        var (exit, stdout, stderr) = OwnedRunner.Run(
            _tmp, declared, "gen", MetaDir, "--out", OutDir, "--template-root", "templates");

        Assert.True(exit == 0, $"exit={exit}\nstdout={stdout}\nstderr={stderr}");
        Assert.Equal("name=Subscriber\n", File.ReadAllText(Path.Combine(OutDir, "Subscriber.summary.txt")));
        var verify = OwnedRunner.Run(_tmp, declared, "verify", "--codegen", MetaDir, "--out", OutDir, "--template-root", "templates");
        Assert.True(verify.ExitCode == 0, $"exit={verify.ExitCode}\nstdout={verify.Stdout}\nstderr={verify.Stderr}");
        Assert.Equal(1, OwnedRunner.Run(_tmp, declared, "verify", "--codegen", MetaDir, "--out", OutDir).ExitCode);
    }

    // ---- a directory gen never had to create is an empty tree, not a missing one ---------------

    [Fact]
    public void An_entry_directory_that_got_no_files_verifies_clean()
    {
        var testsDir = Path.Combine(_tmp, "tests", "Generated");
        IReadOnlyList<IGenerator> declared =
            [new EntityGenerator(), new RequirementTestsGenerator { OutDir = testsDir, WarnUncovered = false }];

        Assert.Equal(0, OwnedRunner.Run(_tmp, declared, "gen", MetaDir, "--out", OutDir).ExitCode);
        Assert.False(Directory.Exists(testsDir));

        var verify = OwnedRunner.Run(_tmp, declared, "verify", MetaDir, "--codegen", "--out", OutDir);
        Assert.True(verify.ExitCode == 0, $"exit={verify.ExitCode}\nstdout={verify.Stdout}\nstderr={verify.Stderr}");
    }

    [Fact]
    public void A_list_of_entries_with_their_own_directories_verifies_clean_in_a_fresh_checkout()
    {
        var testsDir = Path.Combine(_tmp, "tests", "Generated");
        IReadOnlyList<IGenerator> declared =
        [
            new ApiDocsGenerator { OutDir = DocsDir },
            new RequirementTestsGenerator { OutDir = testsDir, WarnUncovered = false },
        ];
        Assert.Equal(0, OwnedRunner.Run(_tmp, declared, "gen", MetaDir, "--out", OutDir).ExitCode);
        Assert.Empty(FilesUnder(OutDir));
        Directory.Delete(OutDir);
        Assert.False(Directory.Exists(testsDir));

        var verify = OwnedRunner.Run(_tmp, declared, "verify", MetaDir, "--codegen", "--out", OutDir);

        Assert.True(verify.ExitCode == 0, $"exit={verify.ExitCode}\nstdout={verify.Stdout}\nstderr={verify.Stderr}");
    }

    [Fact]
    public void Verify_codegen_of_a_list_that_declares_nothing_is_clean()
    {
        Assert.Equal(0, OwnedRunner.Run(_tmp, Array.Empty<IGenerator>(), "gen", MetaDir, "--out", OutDir).ExitCode);

        var verify = OwnedRunner.Run(_tmp, Array.Empty<IGenerator>(), "verify", MetaDir, "--codegen", "--out", OutDir);

        Assert.True(verify.ExitCode == 0, $"exit={verify.ExitCode}\nstdout={verify.Stdout}\nstderr={verify.Stderr}");
        Assert.Contains("codegen/Generators.cs declares no generators; nothing to check", verify.Stdout);
    }

    [Theory]
    [InlineData("gen")]
    [InlineData("verify")]
    public void A_blank_generators_selection_is_refused(string command)
    {
        string[] args = command == "gen"
            ? ["gen", MetaDir, "--out", OutDir, "--generators", ""]
            : ["verify", MetaDir, "--codegen", "--out", OutDir, "--generators", ""];

        var (exit, _, stderr) = OwnedRunner.Run(_tmp, ["entity"], args);

        Assert.Equal(2, exit);
        Assert.Contains("--generators names no generator.", stderr);
        Assert.Empty(FilesUnder(OutDir));
    }
}
