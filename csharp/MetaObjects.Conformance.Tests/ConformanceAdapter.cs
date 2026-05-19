// ConformanceAdapter — C# port adapter.
//
// Ports the contract of conformance/src/adapter.ts + test/conformance/adapter.ts.
// Maps provider ids to IMetaDataTypeProvider objects, composes the registry,
// runs the loader, and exposes canonical serialization.
//
// Navigate / Invoke (capability script) are added in Slice 7.

using MetaObjects;
using MetaObjects.Loader;
using MetaObjects.Meta;

namespace MetaObjects.Conformance.Tests;

/// <summary>
/// Result of loading a fixture's input directory.
/// </summary>
/// <param name="Tree">The loaded metadata tree.</param>
/// <param name="ErrorCodes">Error code strings collected during loading.</param>
/// <param name="Warnings">Warning strings collected during loading.</param>
public sealed record LoadOutcome(
    MetaRoot Tree,
    IReadOnlyList<string> ErrorCodes,
    IReadOnlyList<string> Warnings);

/// <summary>
/// Adapter that bridges the conformance test infrastructure to the C# MetaObjects library.
/// </summary>
public static class ConformanceAdapter
{
    /// <summary>
    /// Provider-id → provider. The fixture corpus names providers by stable id;
    /// this maps them to provider objects. An unknown id throws (parity with the TS adapter).
    /// </summary>
    private static readonly IReadOnlyDictionary<string, IMetaDataTypeProvider> Providers =
        new Dictionary<string, IMetaDataTypeProvider>(StringComparer.Ordinal)
        {
            ["metaobjects-core-types"] = CoreTypes.CoreTypesProvider,
        };

    /// <summary>
    /// Load a fixture's input directory using the specified provider ids.
    /// </summary>
    public static LoadOutcome LoadFixture(string inputDir, IReadOnlyList<string> providers)
    {
        var resolved = providers
            .Select(id => Providers.TryGetValue(id, out var p)
                ? p
                : throw new ArgumentException($"Unknown provider id \"{id}\""))
            .ToList();

        var registry = Provider.ComposeRegistry(resolved);
        var result = new FileMetaDataLoader(registry).LoadDirectory(inputDir);

        return new LoadOutcome(
            result.Root,
            result.Errors.Select(e => e.Code.ToString()).ToList(),
            result.Warnings.ToList());
    }

    /// <summary>
    /// Produce the canonical serialization of a loaded tree.
    /// </summary>
    public static string CanonicalSerialize(MetaRoot tree) =>
        SerializerJson.CanonicalSerialize(tree);

    /// <summary>
    /// Produce the effective (super-resolved) canonical serialization of a loaded tree.
    /// </summary>
    public static string CanonicalSerializeEffective(MetaRoot tree) =>
        SerializerJson.CanonicalSerializeEffective(tree);

    // Slice 7: Navigate / Invoke capability script support.
}
