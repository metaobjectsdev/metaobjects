using MetaObjects.Codegen;
using Xunit;

namespace MetaObjects.Cli.Tests;

/// <summary>
/// <c>dotnet meta gen --column-naming</c> selects how a field with no explicit
/// <c>@column</c> becomes a physical column name.
///
/// <para>The strategy already existed — <c>GenConfig.ColumnNamingStrategy</c>, honoured by
/// every C# generator — but the CLI never set it, so a <c>dotnet meta gen</c> adopter was
/// pinned to <c>Literal</c> with no way out. That is a real break rather than a
/// preference: schema migrations are Node-owned (ADR-0015) and <c>meta migrate</c>
/// defaults to <c>snake_case</c>, so any multi-word field produced an EF entity mapping
/// <c>[Column("createdAt")]</c> against a database column <c>created_at</c>.</para>
///
/// <para>Driven through the entry point a project's codegen/Program.cs calls,
/// <c>CodegenCli.Run(args, list)</c> (<see cref="OwnedRunner"/>), not by calling
/// <c>GenCommand.Run</c>: the defect was precisely that the flag never reached the
/// config, and only the real argument parsing can prove the wiring (same reason as
/// <see cref="MetadataDirFallbackTests"/>).</para>
/// </summary>
[Collection(OwnedRunnerCollection.Name)]
public sealed class ColumnNamingFlagTests : IDisposable
{
    private readonly string _tmp = Path.Combine(Path.GetTempPath(), "meta-cli-colnaming-" + Guid.NewGuid().ToString("N"));

    // `createdAt` has a case boundary; `purposeCode` carries an explicit @column that is
    // deliberately NOT its snake_case, so "the strategy ran" and "@column won" stay distinguishable.
    private const string Metadata = """
    { "metadata.root": { "package": "acme", "children": [
      { "object.entity": { "name": "Subscriber", "children": [
        { "source.rdb": { "@table": "subscribers" } },
        { "field.long":   { "name": "id" } },
        { "field.string": { "name": "createdAt" } },
        { "field.string": { "name": "purposeCode", "@column": "reason" } },
        { "identity.primary": { "@fields": "id" } }
      ]}}
    ]}}
    """;

    private string MetaDir => Path.Combine(_tmp, "metaobjects");

    public ColumnNamingFlagTests()
    {
        Directory.CreateDirectory(MetaDir);
        File.WriteAllText(Path.Combine(MetaDir, "meta.acme.json"), Metadata);
    }

    public void Dispose() { try { Directory.Delete(_tmp, recursive: true); } catch { } }

    // §A6 (task 4) -- [Column] on Subscriber.g.cs now references
    // SubscriberNames.<Field>Column unconditionally; the entity file is BYTE-IDENTICAL
    // regardless of --column-naming. The flag's effect is observable only in the
    // names artifact's DECLARED CONSTANT VALUE, so a caller proving the flag reached
    // GenConfig.ColumnNamingStrategy must read SubscriberNames.g.cs, not Subscriber.g.cs
    // alone -- that is the whole reason this method returns both files.
    private (string Entity, string Names) GenerateWith(params string[] extraArgs)
    {
        var outDir = Path.Combine(_tmp, "generated-" + Guid.NewGuid().ToString("N"));
        // The list declares the two this test reads (entity + names): exactly what its
        // assertions inspect.
        var args = new List<string> { "gen", MetaDir, "--out", outDir, "--namespace", "Acme.Generated" };
        args.AddRange(extraArgs);
        var (exit, stdout, stderr) = OwnedRunner.Run(_tmp, ["entity", "names"], args.ToArray());
        Assert.True(exit == 0, $"exit={exit}\n{stdout}{stderr}");
        var entity = File.ReadAllText(Path.Combine(outDir, "Subscriber.g.cs"));
        var names = File.ReadAllText(Path.Combine(outDir, "SubscriberNames.g.cs"));
        return (entity, names);
    }

    [Fact]
    public void Default_is_literal_unchanged()
    {
        // The entity always references the constant, unconditionally (§A6) -- that part
        // does NOT vary with the flag and is asserted the same way in every test here.
        // What DOES vary with the flag is the constant's declared VALUE, in
        // SubscriberNames.g.cs: "createdAt" (unchanged) under the default strategy.
        var (entity, names) = GenerateWith();
        Assert.Contains("[Column(SubscriberNames.CreatedAtColumn)]", entity);
        Assert.Contains("public const string CreatedAtColumn = \"createdAt\";", names);
    }

    [Fact]
    public void Snake_case_maps_the_field_name_to_a_snake_case_column()
    {
        var (entity, names) = GenerateWith("--column-naming", "snake_case");
        Assert.Contains("[Column(SubscriberNames.CreatedAtColumn)]", entity);
        Assert.Contains("public const string CreatedAtColumn = \"created_at\";", names);
        Assert.DoesNotContain("public const string CreatedAtColumn = \"createdAt\";", names);
    }

    [Fact]
    public void An_explicit_column_attr_wins_over_any_strategy()
    {
        foreach (var (entity, names) in new[] { GenerateWith(), GenerateWith("--column-naming", "snake_case") })
        {
            Assert.Contains("[Column(SubscriberNames.PurposeCodeColumn)]", entity);
            Assert.Contains("public const string PurposeCodeColumn = \"reason\";", names);
            Assert.DoesNotContain("purpose_code", names);
        }
    }

    [Fact]
    public void An_unknown_strategy_is_a_usage_error_naming_the_valid_values()
    {
        var outDir = Path.Combine(_tmp, "generated-bad");
        var (exit, stdout, stderr) = OwnedRunner.Run(
            _tmp, ["entity", "names"], "gen", MetaDir, "--out", outDir, "--column-naming", "PascalCase");
        Assert.Equal(2, exit);
        Assert.Contains("snake_case", stdout + stderr);
    }

    // ---- ColumnNaming declared on the list (ADR-0034 Amendment 9: inputs live in the list) ----

    private GeneratorList ListWith(ColumnNamingStrategy? naming) => new()
    {
        ColumnNaming = naming,
        Entries = OwnedRunner.Declared(_tmp, "entity", "names"),
    };

    private (int Exit, string Out) Gen(IReadOnlyList<IGenerator> list, string outDir, params string[] extra)
    {
        var (exit, stdout, stderr) = OwnedRunner.Run(
            _tmp, list, ["gen", MetaDir, "--out", outDir, "--namespace", "Acme.Generated", .. extra]);
        return (exit, stdout + stderr);
    }

    private (int Exit, string Out) Verify(IReadOnlyList<IGenerator> list, string outDir, params string[] extra)
    {
        var (exit, stdout, stderr) = OwnedRunner.Run(_tmp, list, ["verify", "--codegen", MetaDir, "--out", outDir, .. extra]);
        return (exit, stdout + stderr);
    }

    [Fact]
    public void A_list_that_declares_snake_case_generates_snake_case_with_no_flag_and_verify_agrees()
    {
        var outDir = Path.Combine(_tmp, "generated-list");
        var list = ListWith(ColumnNamingStrategy.SnakeCase);
        var (exit, output) = Gen(list, outDir);
        Assert.True(exit == 0, output);
        Assert.Contains("public const string CreatedAtColumn = \"created_at\";",
            File.ReadAllText(Path.Combine(outDir, "SubscriberNames.g.cs")));

        var (verifyExit, verifyOut) = Verify(list, outDir);
        Assert.True(verifyExit == 0, verifyOut);
        Assert.Contains("OK (generated output is in sync)", verifyOut);
    }

    [Fact]
    public void A_flag_that_agrees_with_the_list_is_accepted_and_one_that_contradicts_it_is_refused()
    {
        var list = ListWith(ColumnNamingStrategy.SnakeCase);
        Assert.Equal(0, Gen(list, Path.Combine(_tmp, "agree"), "--column-naming", "snake_case").Exit);

        var outDir = Path.Combine(_tmp, "contradict");
        var (exit, output) = Gen(list, outDir, "--column-naming", "literal");
        Assert.Equal(2, exit);
        Assert.Contains(
            "--column-naming literal contradicts ColumnNaming = ColumnNamingStrategy.SnakeCase in codegen/Generators.cs",
            output);
        Assert.False(Directory.Exists(outDir));
        Assert.Equal(2, Verify(list, Path.Combine(_tmp, "agree"), "--column-naming", "literal").Exit);
    }

    [Fact]
    public void Verify_with_the_wrong_naming_says_the_naming_differs_instead_of_regenerate()
    {
        // Committed with snake_case; the plain verify runs the default, literal.
        var outDir = Path.Combine(_tmp, "generated-snake");
        Assert.Equal(0, Gen(ListWith(null), outDir, "--column-naming", "snake_case").Exit);

        var (exit, output) = Verify(ListWith(null), outDir);
        Assert.Equal(1, exit);
        Assert.Contains(
            "The committed output was generated with column naming snake_case; this run used literal (the default). " +
            "Do not regenerate",
            output);
        Assert.Contains("ColumnNaming = ColumnNamingStrategy.SnakeCase on the GeneratorList in codegen/Generators.cs", output);
        Assert.DoesNotContain("Run 'dotnet meta gen' to regenerate", output);
    }

    [Fact]
    public void Real_drift_still_says_regenerate()
    {
        var outDir = Path.Combine(_tmp, "generated-edited");
        Assert.Equal(0, Gen(ListWith(ColumnNamingStrategy.SnakeCase), outDir).Exit);
        File.AppendAllText(Path.Combine(outDir, "SubscriberNames.g.cs"), "// edited\n");

        var (exit, output) = Verify(ListWith(ColumnNamingStrategy.SnakeCase), outDir);
        Assert.Equal(1, exit);
        Assert.Contains("Run 'dotnet meta gen' to regenerate", output);
        Assert.DoesNotContain("column naming", output);
    }
}
