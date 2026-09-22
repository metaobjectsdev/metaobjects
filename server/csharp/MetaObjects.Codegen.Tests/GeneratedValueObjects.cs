using MetaObjects.Codegen.Generators;
using MetaObjects.Meta;

namespace MetaObjects.Codegen.Tests;

/// <summary>
/// ADR-0056 — the template tier declares no type for a value object; it references the POCO
/// EntityGenerator emits. A test that compiles template-tier output therefore compiles it with
/// this: the value-object tier, generated exactly as `dotnet meta gen --generators entity` would.
/// </summary>
internal static class GeneratedValueObjects
{
    /// <summary>EntityGenerator's output for <paramref name="root"/>, as source strings.</summary>
    public static string[] Sources(MetaRoot root, string ns = "Acme.Generated") =>
        Sources(root, new GenConfig { OutDir = "/tmp", Namespace = ns });

    /// <summary>EntityGenerator's output for <paramref name="root"/> under <paramref name="config"/>.</summary>
    public static string[] Sources(MetaRoot root, GenConfig config) =>
        new EntityGenerator()
            .Generate(new GenContext { Entities = root.Objects(), Root = root, Config = config })
            .Select(f => f.Content)
            .ToArray();
}
