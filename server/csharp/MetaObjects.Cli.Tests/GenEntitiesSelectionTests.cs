// `dotnet meta gen --entities A,B` — the C# analogue of TypeScript's positional entity names
// and Python's `--entities`: only PER-OBJECT output narrows, whole-model files still render from
// the whole model, and a narrowed run neither deletes nor forgets the unselected objects' files.

using MetaObjects.Codegen;
using Xunit;

namespace MetaObjects.Cli.Tests;

[Collection(OwnedRunnerCollection.Name)]
public sealed class GenEntitiesSelectionTests : IDisposable
{
    private readonly string _tmp = Path.Combine(Path.GetTempPath(), "meta-entities-" + Guid.NewGuid().ToString("N"));
    private string MetaDir => Path.Combine(_tmp, "metaobjects");
    private string OutDir => Path.Combine(_tmp, "generated");
    private string ManifestText() => string.Concat(
        Directory.GetFiles(Path.Combine(_tmp, ".metaobjects", ".gen-state", ".hashes"), "*.json").Order(StringComparer.Ordinal)
            .Select(File.ReadAllText));

    private static string Entity(string name, string table) => $$$"""
      { "object.entity": { "name": "{{{name}}}", "children": [
        { "source.rdb": { "@table": "{{{table}}}" } },
        { "field.long":   { "name": "id" } },
        { "field.string": { "name": "label" } },
        { "identity.primary": { "@fields": "id" } }
      ]}}
    """;

    public GenEntitiesSelectionTests()
    {
        Directory.CreateDirectory(MetaDir);
        File.WriteAllText(Path.Combine(MetaDir, "meta.acme.json"),
            "{ \"metadata.root\": { \"package\": \"acme\", \"children\": [" +
            Entity("Product", "products") + "," + Entity("Supplier", "suppliers") + "," + Entity("Widget", "widgets") + "]}}");
    }

    public void Dispose() { try { Directory.Delete(_tmp, recursive: true); } catch { } }

    private static readonly string[] Suite = ["entity", "names", "db-context", "routes"];

    private (int ExitCode, string Stdout, string Stderr) Gen(params string[] extra) =>
        OwnedRunner.Run(_tmp, Suite, ["gen", MetaDir, "--out", OutDir, "--namespace", "Acme.Generated", .. extra]);

    private string Read(string file) => File.ReadAllText(Path.Combine(OutDir, file));
    private bool Has(string file) => File.Exists(Path.Combine(OutDir, file));

    [Fact]
    public void Selection_writes_only_the_selected_objects_per_object_files()
    {
        var (exit, stdout, stderr) = Gen("--entities", "Product, Supplier");

        Assert.True(exit == 0, $"exit={exit}\n{stdout}\n{stderr}");
        Assert.True(Has("Product.g.cs"));
        Assert.True(Has("Supplier.g.cs"));
        Assert.True(Has("ProductNames.g.cs"));
        Assert.False(Has("Widget.g.cs"));
        Assert.False(Has("WidgetNames.g.cs"));
        Assert.DoesNotContain(Directory.GetFiles(OutDir, "*", SearchOption.AllDirectories), f => f.Contains("Widget"));
    }

    [Fact]
    public void A_whole_model_file_is_identical_to_the_unfiltered_run()
    {
        Assert.Equal(0, Gen().ExitCode);
        var full = Read("AppDbContext.g.cs");
        Assert.Contains("Widget", full);
        Directory.Delete(OutDir, recursive: true);

        Assert.Equal(0, Gen("--entities", "Product").ExitCode);

        Assert.Equal(full, Read("AppDbContext.g.cs"));
        Assert.False(Has("Widget.g.cs"));
    }

    [Fact]
    public void Selecting_an_object_the_context_does_not_cover_still_renders_the_whole_context()
    {
        // A sourceless value object adds nothing to the DbContext, yet the context is whole-model.
        File.WriteAllText(Path.Combine(MetaDir, "meta.vo.json"),
            "{ \"metadata.root\": { \"package\": \"acme\", \"children\": [" +
            "{ \"object.value\": { \"name\": \"Money\", \"children\": [ { \"field.string\": { \"name\": \"code\" } } ]}}]}}");
        Assert.Equal(0, Gen().ExitCode);
        var full = Read("AppDbContext.g.cs");
        File.Delete(Path.Combine(OutDir, "AppDbContext.g.cs"));

        Assert.Equal(0, Gen("--entities", "Money").ExitCode);

        Assert.Equal(full, Read("AppDbContext.g.cs"));
    }

    [Fact]
    public void Shared_files_inside_a_per_object_generator_still_render_whole_when_the_selection_does_not_touch_them()
    {
        // A shared enum and a decimal wire helper are consumed only by Gadget; selecting Product
        // contributes nothing to either, yet each is built from the whole model.
        File.WriteAllText(Path.Combine(MetaDir, "meta.gadget.json"),
            "{ \"metadata.root\": { \"package\": \"acme\", \"children\": [" +
            "{ \"field.enum\": { \"name\": \"GadgetState\", \"abstract\": true, \"@values\": [\"ON\", \"OFF\"] } }," +
            "{ \"object.entity\": { \"name\": \"Gadget\", \"children\": [" +
            "{ \"source.rdb\": { \"@table\": \"gadgets\" } }," +
            "{ \"field.long\": { \"name\": \"id\" } }," +
            "{ \"field.decimal\": { \"name\": \"price\" } }," +
            "{ \"field.enum\": { \"name\": \"state\", \"extends\": \"GadgetState\" } }," +
            "{ \"identity.primary\": { \"@fields\": \"id\" } }]}}]}}");
        Assert.Equal(0, Gen().ExitCode);
        var enums = Read("Enums.g.cs");
        var wire = Read("DecimalWire.g.cs");
        Assert.Contains("GadgetState", enums);
        Directory.Delete(OutDir, recursive: true);

        var (exit, stdout, stderr) = Gen("--entities", "Product");

        Assert.True(exit == 0, $"exit={exit}\n{stdout}\n{stderr}");
        Assert.Equal(enums, Read("Enums.g.cs"));
        Assert.Equal(wire, Read("DecimalWire.g.cs"));
        Assert.False(Has("Gadget.g.cs"));
        Assert.True(Has("Product.g.cs"));
    }

    [Fact]
    public void A_narrowed_run_neither_deletes_nor_forgets_the_unselected_files()
    {
        Assert.Equal(0, Gen().ExitCode);
        var widget = Read("Widget.g.cs");
        var manifestBefore = ManifestText();
        Assert.Contains("Widget.g.cs", manifestBefore);

        // Metadata drops Widget: a full run would sweep its files, a narrowed one must not.
        File.WriteAllText(Path.Combine(MetaDir, "meta.acme.json"),
            "{ \"metadata.root\": { \"package\": \"acme\", \"children\": [" + Entity("Product", "products") + "]}}");
        var (exit, stdout, stderr) = Gen("--entities", "Product");

        Assert.True(exit == 0, $"exit={exit}\n{stdout}\n{stderr}");
        Assert.Equal(widget, Read("Widget.g.cs"));
        Assert.DoesNotContain("removed:", stdout);
        var manifestAfter = ManifestText();
        Assert.Contains("Widget.g.cs", manifestAfter);
        Assert.Contains("WidgetNames.g.cs", manifestAfter);
        Assert.Contains("Supplier.g.cs", manifestAfter);
    }

    [Fact]
    public void Verify_narrowed_to_entities_checks_only_the_selected_objects()
    {
        Assert.Equal(0, Gen("--entities", "Product").ExitCode);

        var verify = OwnedRunner.Run(_tmp, Suite,
            "verify", "--codegen", MetaDir, "--out", OutDir, "--namespace", "Acme.Generated", "--entities", "Product");

        Assert.True(verify.ExitCode == 0, $"exit={verify.ExitCode}\n{verify.Stdout}\n{verify.Stderr}");
    }

    [Fact]
    public void A_blank_selection_is_refused()
    {
        var (exit, _, stderr) = Gen("--entities", " , ");

        Assert.Equal(2, exit);
        Assert.Contains("error: dotnet meta gen: --entities names no object.", stderr);
        Assert.False(Directory.Exists(OutDir));
    }

    [Fact]
    public void A_name_matching_no_object_is_refused_and_writes_nothing()
    {
        var (exit, _, stderr) = Gen("--entities", "Product,Nope,Gone");

        Assert.Equal(2, exit);
        Assert.Contains("error: dotnet meta gen: --entities names 'Nope', 'Gone', which matches no object in the metadata.", stderr);
        Assert.False(Directory.Exists(OutDir));
    }

    [Fact]
    public void Without_the_flag_every_object_is_written()
    {
        Assert.Equal(0, Gen().ExitCode);

        Assert.True(Has("Widget.g.cs"));
        Assert.True(Has("Supplier.g.cs"));
    }
}
