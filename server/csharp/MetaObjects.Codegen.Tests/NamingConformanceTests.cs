// NamingConformanceTests — runs the shared cross-port ADR-0058 physical-naming corpus
// (fixtures/naming-conformance/physical-names/) against the C# port.
//
// Each `cases[]` entry is the `naming` block of a project's `.metaobjects/config.json`.
// This test writes exactly that file to a throwaway project directory and parses it with
// the C# config reader (MetaObjects.Config.NeutralConfig — the same reader every
// project-aware load goes through), loads the shared meta.naming.json model, sets the
// naming on the loaded root (ADR-0058: the loaded root carries it), and resolves every
// expected table and column name through the SAME doors codegen uses — CSharpNaming.Table
// and CSharpNaming.Column — never a reimplementation. Each `invalid` block must be refused
// when the config is read.
using System.Text.Json;
using MetaObjects.Config;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public class NamingConformanceTests
{
    private static string FixtureDir =>
        Path.Combine(CorpusPaths.RepoRoot(), "fixtures", "naming-conformance", "physical-names");

    private static string CasesPath => Path.Combine(FixtureDir, "cases.json");
    private static string ModelPath => Path.Combine(FixtureDir, "meta.naming.json");

    private sealed record Case(
        string Name, JsonElement? Naming, Dictionary<string, string> Tables, Dictionary<string, string> Columns);

    private static JsonDocument CasesDoc() => JsonDocument.Parse(File.ReadAllText(CasesPath));

    public static TheoryData<string> ValidCaseNames()
    {
        var data = new TheoryData<string>();
        using var doc = CasesDoc();
        foreach (var el in doc.RootElement.GetProperty("cases").EnumerateArray())
            data.Add(el.GetProperty("name").GetString()!);
        return data;
    }

    public static TheoryData<string> InvalidCaseNames()
    {
        var data = new TheoryData<string>();
        using var doc = CasesDoc();
        foreach (var el in doc.RootElement.GetProperty("invalid").EnumerateArray())
            data.Add(el.GetProperty("name").GetString()!);
        return data;
    }

    private static Case LoadValidCase(string name)
    {
        using var doc = CasesDoc();
        var el = doc.RootElement.GetProperty("cases").EnumerateArray()
            .Single(c => c.GetProperty("name").GetString() == name);
        var namingEl = el.GetProperty("naming");
        var naming = namingEl.ValueKind == JsonValueKind.Null ? (JsonElement?)null : namingEl.Clone();
        var tables = el.GetProperty("tables").EnumerateObject().ToDictionary(p => p.Name, p => p.Value.GetString()!);
        var columns = el.GetProperty("columns").EnumerateObject().ToDictionary(p => p.Name, p => p.Value.GetString()!);
        return new Case(name, naming, tables, columns);
    }

    private static JsonElement LoadInvalidNaming(string name)
    {
        using var doc = CasesDoc();
        var el = doc.RootElement.GetProperty("invalid").EnumerateArray()
            .Single(c => c.GetProperty("name").GetString() == name);
        return el.GetProperty("naming").Clone();
    }

    /// <summary>
    /// Writes a throwaway project's <c>.metaobjects/config.json</c> carrying <paramref
    /// name="naming"/> (or no <c>naming</c> key at all when null), and parses it with
    /// <see cref="NeutralConfig.Read"/> — the config reader every project-aware load uses.
    /// </summary>
    private static PhysicalNaming ReadNaming(JsonElement? naming)
    {
        var dir = Path.Combine(Path.GetTempPath(), "mo-naming-conf-" + Guid.NewGuid().ToString("N"));
        var cfgDir = Path.Combine(dir, ".metaobjects");
        Directory.CreateDirectory(cfgDir);
        var body = naming is { } n
            ? $$"""{ "schema_version": 1, "naming": {{n.GetRawText()}} }"""
            : """{ "schema_version": 1 }""";
        File.WriteAllText(Path.Combine(cfgDir, "config.json"), body);
        try
        {
            return NeutralConfig.Read(dir)?.Naming ?? PhysicalNaming.Default;
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    private static MetaRoot LoadModel(PhysicalNaming naming)
    {
        var result = new MetaDataLoader().Load([new FileSource(ModelPath)]);
        Assert.True(result.Errors.Count == 0,
            "the shared naming corpus model must load cleanly:\n" +
            string.Join("\n", result.Errors.Select(e => $"  {e.Code}: {e.Message}")));
        // ADR-0058 — the loaded root carries the project's naming rules.
        result.Root.PhysicalNaming = naming;
        return result.Root;
    }

    [Theory]
    [MemberData(nameof(ValidCaseNames))]
    public void Resolves_every_table_and_column_name(string name)
    {
        var c = LoadValidCase(name);
        var naming = ReadNaming(c.Naming);
        var root = LoadModel(naming);

        foreach (var (objectName, expectedTable) in c.Tables)
        {
            var obj = root.FindObject(objectName);
            Assert.NotNull(obj);
            // CSharpNaming.Table is the exact door the entity/db-context generators call.
            Assert.Equal(expectedTable, CSharpNaming.Table(obj!));
        }

        foreach (var (key, expectedColumn) in c.Columns)
        {
            var parts = key.Split('.', 2);
            var obj = root.FindObject(parts[0]);
            Assert.NotNull(obj);
            // ADR-0039: Fields() is the resolving accessor (an inherited field must resolve).
            var field = obj!.Fields().FirstOrDefault(f => f.Name == parts[1]);
            Assert.NotNull(field);
            // CSharpNaming.Column is the exact door the entity/names generators call.
            Assert.Equal(expectedColumn, CSharpNaming.Column(field!, naming.Columns));
        }
    }

    [Theory]
    [MemberData(nameof(InvalidCaseNames))]
    public void Refuses_invalid_naming_blocks(string name)
    {
        var naming = LoadInvalidNaming(name);
        Assert.ThrowsAny<MetaObjects.MetaModelException>(() => ReadNaming(naming));
    }
}
