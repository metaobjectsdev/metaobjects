using Xunit;

namespace MetaObjects.Cli.Tests;

/// <summary>
/// ADR-0058 — column and table naming is one project setting now: <c>naming</c> in
/// <c>.metaobjects/config.json</c>, read by every port. This port's old
/// <c>--column-naming</c> flag on <c>dotnet meta gen</c> / <c>dotnet meta verify --codegen</c>
/// is REMOVED: it refuses with the migration message rather than silently doing nothing or
/// guessing (the old value may have been right for an adopter's real database).
///
/// <para>The DEFAULT also flipped: this port used to default columns to <c>literal</c> (the EF
/// Core property=column convention); it now defaults to <c>snake_case</c>, matching what
/// <c>meta migrate</c> has always created — the defect ADR-0058 exists to fix (gen's and
/// migrate's defaults used to disagree).</para>
///
/// <para>Driven through the entry point a project's codegen/Program.cs calls,
/// <c>CodegenCli.Run(args, list)</c> (<see cref="OwnedRunner"/>), not by calling
/// <c>GenCommand.Run</c>: only the real argument parsing proves the flag is actually refused
/// (same reason as <see cref="MetadataDirFallbackTests"/>).</para>
/// </summary>
[Collection(OwnedRunnerCollection.Name)]
public sealed class ColumnNamingFlagTests : IDisposable
{
    private readonly string _tmp = Path.Combine(Path.GetTempPath(), "meta-cli-colnaming-" + Guid.NewGuid().ToString("N"));

    // `createdAt` has a case boundary; `purposeCode` carries an explicit @column that is
    // deliberately NOT its snake_case, so "the rule ran" and "@column won" stay distinguishable.
    // `OrderItem` names no table, so its table name comes from the table rule
    // (snake_case "order_items", literal "OrderItems").
    private const string Metadata = """
    { "metadata.root": { "package": "acme", "children": [
      { "object.entity": { "name": "Subscriber", "children": [
        { "source.rdb": { "@table": "subscribers" } },
        { "field.long":   { "name": "id" } },
        { "field.string": { "name": "createdAt" } },
        { "field.string": { "name": "purposeCode", "@column": "reason" } },
        { "identity.primary": { "@fields": "id" } }
      ]}},
      { "object.entity": { "name": "OrderItem", "children": [
        { "source.rdb": {} },
        { "field.long":   { "name": "id" } },
        { "field.long":   { "name": "unitPrice" } },
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

    /// <summary>Writes <c>.metaobjects/config.json</c> at the project root with the given
    /// <c>naming</c> JSON body (e.g. <c>"\"columns\": \"literal\""</c>), or no <c>naming</c>
    /// key at all when <paramref name="naming"/> is null.</summary>
    private void WriteConfig(string? naming)
    {
        var dir = Path.Combine(_tmp, ".metaobjects");
        Directory.CreateDirectory(dir);
        var json = naming is null
            ? """{ "schema_version": 1 }"""
            : $$"""{ "schema_version": 1, "naming": { {{naming}} } }""";
        File.WriteAllText(Path.Combine(dir, "config.json"), json);
    }

    // §A6 (task 4) -- [Column] on Subscriber.g.cs now references
    // SubscriberNames.<Field>Column unconditionally; the entity file is BYTE-IDENTICAL
    // regardless of the naming rule. The rule's effect is observable only in the names
    // artifact's DECLARED CONSTANT VALUE, so a caller proving the rule reached
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
    public void Default_with_no_project_config_is_snake_case()
    {
        // No .metaobjects/config.json at all -- PhysicalNaming.Default applies.
        var (entity, names) = GenerateWith();
        Assert.Contains("[Column(SubscriberNames.CreatedAtColumn)]", entity);
        Assert.Contains("public const string CreatedAtColumn = \"created_at\";", names);
    }

    [Fact]
    public void Config_declaring_literal_columns_generates_literal()
    {
        WriteConfig("\"columns\": \"literal\"");
        var (entity, names) = GenerateWith();
        Assert.Contains("[Column(SubscriberNames.CreatedAtColumn)]", entity);
        Assert.Contains("public const string CreatedAtColumn = \"createdAt\";", names);
        Assert.DoesNotContain("created_at", names);
    }

    [Fact]
    public void An_explicit_column_attr_wins_over_any_rule()
    {
        foreach (var naming in new string?[] { null, "\"columns\": \"literal\"" })
        {
            if (naming is not null) WriteConfig(naming);
            var (entity, names) = GenerateWith();
            Assert.Contains("[Column(SubscriberNames.PurposeCodeColumn)]", entity);
            Assert.Contains("public const string PurposeCodeColumn = \"reason\";", names);
            Assert.DoesNotContain("purpose_code", names);
        }
    }

    [Fact]
    public void The_removed_flag_is_refused_on_gen_naming_the_value_given()
    {
        var outDir = Path.Combine(_tmp, "generated-bad");
        var (exit, stdout, stderr) = OwnedRunner.Run(
            _tmp, ["entity", "names"], "gen", MetaDir, "--out", outDir, "--column-naming", "snake_case");
        var output = stdout + stderr;
        Assert.Equal(2, exit);
        Assert.Contains("--column-naming was removed in 1.1.0", output);
        Assert.Contains("\"naming\": { \"columns\": \"snake_case\" }", output);
        Assert.Contains("docs/features/migrations/physical-naming.md", output);
        Assert.Contains("delete --column-naming", output);
        Assert.False(Directory.Exists(outDir));
    }

    [Fact]
    public void The_removed_flag_is_refused_on_verify_codegen()
    {
        var outDir = Path.Combine(_tmp, "generated-ok");
        Assert.Equal(0, OwnedRunner.Run(_tmp, ["entity", "names"], "gen", MetaDir, "--out", outDir).ExitCode);

        var (exit, stdout, stderr) = OwnedRunner.Run(
            _tmp, ["entity", "names"], "verify", "--codegen", MetaDir, "--out", outDir, "--column-naming", "literal");
        var output = stdout + stderr;
        Assert.Equal(2, exit);
        Assert.Contains("--column-naming was removed in 1.1.0", output);
        Assert.Contains("\"naming\": { \"columns\": \"literal\" }", output);
    }

    [Fact]
    public void Verify_with_the_wrong_naming_says_the_naming_differs_instead_of_regenerate()
    {
        // Committed under the project's snake_case rule; then the config changes to literal.
        // The two disagree, and literal reproduces the committed output exactly, so verify
        // must say WHICH naming to declare rather than "regenerate" (that would commit the
        // wrong column names against the live database).
        var outDir = Path.Combine(_tmp, "generated-snake");
        WriteConfig("\"columns\": \"snake_case\"");
        Assert.Equal(0, OwnedRunner.Run(_tmp, ["entity", "names"], "gen", MetaDir, "--out", outDir).ExitCode);

        WriteConfig("\"columns\": \"literal\"");
        var (exit, stdout, stderr) = OwnedRunner.Run(_tmp, ["entity", "names"], "verify", "--codegen", MetaDir, "--out", outDir);
        var output = stdout + stderr;
        Assert.Equal(1, exit);
        Assert.Contains(
            "The committed output was generated with \"naming\": { \"columns\": \"snake_case\", \"tables\": \"snake_case\" }; " +
            "this run used \"naming\": { \"columns\": \"literal\", \"tables\": \"snake_case\" } " +
            "(.metaobjects/config.json; each rule defaults to snake_case). Do not regenerate",
            output);
        Assert.Contains(
            "Declare \"naming\": { \"columns\": \"snake_case\", \"tables\": \"snake_case\" } in .metaobjects/config.json",
            output);
        Assert.DoesNotContain("Run 'dotnet meta gen' to regenerate", output);
    }

    [Fact]
    public void Verify_with_another_table_rule_says_the_naming_differs_instead_of_regenerate()
    {
        // Committed under literal tables ("OrderItems"); then the config drops the table rule, so
        // the default snake_case ("order_items") disagrees. Regenerating would bind the entity to
        // a table the database does not have, so verify names the table rule that reproduces it.
        var outDir = Path.Combine(_tmp, "generated-literal-tables");
        WriteConfig("\"tables\": \"literal\"");
        Assert.Equal(0, OwnedRunner.Run(_tmp, ["entity", "names"], "gen", MetaDir, "--out", outDir).ExitCode);
        Assert.Contains("\"OrderItems\"", File.ReadAllText(Path.Combine(outDir, "OrderItemNames.g.cs")));

        WriteConfig(null);
        var (exit, stdout, stderr) = OwnedRunner.Run(_tmp, ["entity", "names"], "verify", "--codegen", MetaDir, "--out", outDir);
        var output = stdout + stderr;
        Assert.Equal(1, exit);
        Assert.Contains(
            "The committed output was generated with \"naming\": { \"columns\": \"snake_case\", \"tables\": \"literal\" }; " +
            "this run used \"naming\": { \"columns\": \"snake_case\", \"tables\": \"snake_case\" }",
            output);
        Assert.Contains(
            "Declare \"naming\": { \"columns\": \"snake_case\", \"tables\": \"literal\" } in .metaobjects/config.json",
            output);
        Assert.DoesNotContain("Run 'dotnet meta gen' to regenerate", output);
    }

    [Fact]
    public void Verify_finds_a_column_and_table_rule_that_differ_together()
    {
        // Committed under literal columns AND literal tables; the config now declares neither.
        // No single rule change reproduces the committed tree; the two together do.
        var outDir = Path.Combine(_tmp, "generated-literal-both");
        WriteConfig("\"columns\": \"literal\", \"tables\": \"literal\"");
        Assert.Equal(0, OwnedRunner.Run(_tmp, ["entity", "names"], "gen", MetaDir, "--out", outDir).ExitCode);

        WriteConfig(null);
        var (exit, stdout, stderr) = OwnedRunner.Run(_tmp, ["entity", "names"], "verify", "--codegen", MetaDir, "--out", outDir);
        var output = stdout + stderr;
        Assert.Equal(1, exit);
        Assert.Contains(
            "Declare \"naming\": { \"columns\": \"literal\", \"tables\": \"literal\" } in .metaobjects/config.json",
            output);
        Assert.DoesNotContain("Run 'dotnet meta gen' to regenerate", output);
    }

    [Fact]
    public void Real_drift_still_says_regenerate()
    {
        var outDir = Path.Combine(_tmp, "generated-edited");
        WriteConfig("\"columns\": \"snake_case\"");
        Assert.Equal(0, OwnedRunner.Run(_tmp, ["entity", "names"], "gen", MetaDir, "--out", outDir).ExitCode);
        File.AppendAllText(Path.Combine(outDir, "SubscriberNames.g.cs"), "// edited\n");

        var (exit, stdout, stderr) = OwnedRunner.Run(_tmp, ["entity", "names"], "verify", "--codegen", MetaDir, "--out", outDir);
        var output = stdout + stderr;
        Assert.Equal(1, exit);
        Assert.Contains("Run 'dotnet meta gen' to regenerate", output);
        Assert.DoesNotContain("The committed output was generated with", output);
    }
}
