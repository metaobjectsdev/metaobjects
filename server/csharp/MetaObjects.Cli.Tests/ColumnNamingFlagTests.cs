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
}
