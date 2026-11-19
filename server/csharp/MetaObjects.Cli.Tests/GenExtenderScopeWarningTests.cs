using Xunit;

namespace MetaObjects.Cli.Tests;

/// <summary>
/// rc.21 part B (I2): an extender keeps its super's identity anchor, so a view whose own fields
/// read a TPH subtype's columns returns every base row. The loader records that on its warning
/// channel, which `dotnet meta gen` does not print; gen now says it, and keeps its exit code.
/// </summary>
[Collection(OwnedRunnerCollection.Name)]
public sealed class GenExtenderScopeWarningTests : IDisposable
{
    private readonly string _tmp = Path.Combine(Path.GetTempPath(), "meta-gen-extender-scope-" + Guid.NewGuid().ToString("N"));
    private string MetaDir => Path.Combine(_tmp, "metaobjects");
    private string OutDir => Path.Combine(_tmp, "out");

    private static string Model(string filter) => $$"""
      { "metadata.root": { "package": "acme", "children": [
        { "object.entity": { "name": "Vehicle", "@discriminator": "kind", "children": [
          { "source.rdb": { "@table": "vehicles" } }, { "field.long": { "name": "id" } }, { "field.string": { "name": "kind", "@maxLength": 10 } },
          { "identity.primary": { "@fields": "id" } } ] } },
        { "object.entity": { "name": "Truck", "extends": "Vehicle", "@discriminatorValue": "TRUCK", "children": [ { "field.string": { "name": "payloadClass" } } ] } },
        { "object.projection": { "name": "VehicleBase", "abstract": true, "children": [
          { "field.long": { "name": "vehicleId", "extends": "Vehicle.id" } }, { "identity.primary": { "name": "id", "extends": "Vehicle.primary" } } ] } },
        { "object.projection": { "name": "TruckRow", "extends": "VehicleBase", {{filter}} "children": [
          { "source.rdb": { "@kind": "view", "@view": "v_trucks" } },
          { "field.string": { "name": "payload", "extends": "Truck.payloadClass" } } ] } } ] } }
    """;

    public GenExtenderScopeWarningTests() => Directory.CreateDirectory(MetaDir);

    public void Dispose() { try { Directory.Delete(_tmp, recursive: true); } catch { } }

    [Fact]
    public void Gen_prints_the_widened_extender_warning_and_keeps_its_exit_code()
    {
        File.WriteAllText(Path.Combine(MetaDir, "meta.acme.json"), Model(""));
        var run = OwnedRunner.Run(_tmp, ["entity"], "gen", MetaDir, "--out", OutDir, "--namespace", "Acme");
        Assert.Equal(0, run.ExitCode);
        Assert.Contains("object.projection TruckRow", run.Stderr);
        Assert.Contains("\"payload\" (Truck.payloadClass)", run.Stderr);
        Assert.Contains("@filter { kind: <value> }", run.Stderr);
    }

    [Fact]
    public void A_discriminator_filter_scopes_it_and_gen_says_nothing()
    {
        File.WriteAllText(Path.Combine(MetaDir, "meta.acme.json"), Model("\"@filter\": { \"kind\": \"TRUCK\" },"));
        var run = OwnedRunner.Run(_tmp, ["entity"], "gen", MetaDir, "--out", OutDir, "--namespace", "Acme");
        Assert.Equal(0, run.ExitCode);
        Assert.DoesNotContain("object.projection TruckRow", run.Stderr);
    }
}
