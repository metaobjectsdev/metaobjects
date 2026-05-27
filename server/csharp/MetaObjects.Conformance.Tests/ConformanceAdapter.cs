// ConformanceAdapter — C# port adapter.
//
// Ports the contract of conformance/src/adapter.ts + test/conformance/adapter.ts.
// Maps provider ids to IMetaDataTypeProvider objects, composes the registry,
// runs the loader, and exposes canonical serialization.
//
// Navigate / Invoke (capability script) are added in Slice 7.

using MetaObjects;
using MetaObjects.Core.Documentation;
using MetaObjects.Loader;
using MetaObjects.Meta;
using MetaObjects.Source;

namespace MetaObjects.Conformance.Tests;

/// <summary>
/// Cross-port envelope record surfaced by <see cref="LoadOutcome.Errors"/>.
/// Mirrors the TS <c>ErrorEnvelopeRecord</c> shape so the C# runner can do
/// the same per-error envelope assertion the TS runner does.
/// </summary>
public sealed record ErrorEnvelopeRecord(
    string Code,
    string Format,
    IReadOnlyList<string> Files,
    string? JsonPath);

/// <summary>
/// Result of loading a fixture's input directory.
/// </summary>
/// <param name="Tree">The loaded metadata tree.</param>
/// <param name="ErrorCodes">Error code strings collected during loading.</param>
/// <param name="Warnings">Warning strings collected during loading.</param>
/// <param name="Errors">Full envelope records (FR5a / ADR-0009). Populated alongside <see cref="ErrorCodes"/>.</param>
public sealed record LoadOutcome(
    MetaRoot Tree,
    IReadOnlyList<string> ErrorCodes,
    IReadOnlyList<string> Warnings,
    IReadOnlyList<ErrorEnvelopeRecord> Errors);

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
            ["metaobjects-core-types"]    = CoreTypes.CoreTypesProvider,
            ["metaobjects-documentation"] = DocumentationTypes.DocTypesProvider,
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
        var result = MetaDataLoader.FromDirectory(inputDir, registry);

        // FR5a — surface the full envelope per error. Normalize files[] to
        // be relative to inputDir (the harness's portable file token).
        var envelopes = result.Errors.Select(e => BuildEnvelope(e, inputDir)).ToList();

        return new LoadOutcome(
            result.Root,
            result.Errors.Select(e => e.Code.ToString()).ToList(),
            result.Warnings.ToList(),
            envelopes);
    }

    private static ErrorEnvelopeRecord BuildEnvelope(MetaError err, string inputDir)
    {
        var code = err.Code.ToString();
        IReadOnlyList<string> Rel(IEnumerable<string> files) =>
            files.Select(f => RelativizeFile(f, inputDir)).ToList();
        return err.Envelope switch
        {
            JsonSource js     => new ErrorEnvelopeRecord(code, "json",     Rel(js.Files), js.JsonPath),
            YamlSource ys     => new ErrorEnvelopeRecord(code, "yaml",     Rel(ys.Files), ys.JsonPath),
            MergedSource ms   => new ErrorEnvelopeRecord(code, "merged",   Rel(ms.Files), ms.JsonPath),
            ResolvedSource rs => new ErrorEnvelopeRecord(code, "resolved", Rel(rs.Files), rs.JsonPath),
            CodeSource        => new ErrorEnvelopeRecord(code, "code",     new List<string>(), null),
            // Pre-FR5a fallback: no envelope. Synthesize a minimal $-rooted JSON shape.
            _                 => new ErrorEnvelopeRecord(code, "json",     new List<string>(), "$"),
        };
    }

    private static string RelativizeFile(string filePath, string inputDir)
    {
        if (filePath.StartsWith(inputDir, StringComparison.Ordinal))
        {
            var rel = System.IO.Path.GetRelativePath(inputDir, filePath);
            return rel.Replace('\\', '/');
        }
        return filePath.Replace('\\', '/');
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

    /// <summary>
    /// Navigate a path from the tree root, returning the resolved node or
    /// <see langword="null"/> if any segment does not match.
    /// </summary>
    public static MetaData? Navigate(MetaRoot tree, IReadOnlyList<string> path) =>
        Navigator.Navigate(tree, path);

    /// <summary>
    /// Invoke a capability on a node. Throws <see cref="UnknownCapabilityException"/>
    /// for an unbound capability-id.
    /// </summary>
    public static NormalizedResult Invoke(
        MetaData node,
        string capabilityId,
        IReadOnlyDictionary<string, object?> args) =>
        CapabilityBinding.Invoke(node, capabilityId, args);
}
