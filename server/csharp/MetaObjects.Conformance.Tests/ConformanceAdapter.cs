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
using MetaObjects.Shared;

namespace MetaObjects.Conformance.Tests;

// ---------------------------------------------------------------------------
// Test-only providers exercised by the provider-extension-* fixtures.
//
// These are NOT shipped — they live in test code to verify the cross-port
// composition contract end-to-end. Each adapter (TS / C# / Python) carries
// the same set so fixture-declared provider ids resolve identically.
// ---------------------------------------------------------------------------

// Adds a hypothetical `template.briefing` subtype with @payloadRef + @author
// + @recipient. Fictional — used only by the provider-extension-* fixtures
// to exercise registry.Register without colliding with real core subtypes.
// (Pre-ADR-0011 this was a "toolcall" subtype; toolcall is now core, so the
// test-only one moved to a clearly-fictional name.)
internal sealed class ExampleTemplateBriefingProvider : IMetaDataTypeProvider
{
    public string Id => "example-template-briefing";
    public IReadOnlyList<string> Dependencies => new[] { "metaobjects-core-types" };

    public void RegisterTypes(TypeRegistry registry)
    {
        registry.Register(new TypeDefinition(
            typeId: new TypeId("template", "briefing"),
            description: "Hypothetical briefing template — test-only.",
            childRules: new List<ChildRule>
            {
                new ChildRule(
                    BaseTypes.TYPE_ATTR,
                    Structural.CHILD_RULE_WILDCARD,
                    Structural.CHILD_RULE_WILDCARD),
            },
            factory: (typeId, name) => new MetaTemplate(typeId, name),
            attributes: new List<AttrSchema>
            {
                new AttrSchema("payloadRef", "string", Required: true, Description: "Briefing-input payload reference."),
                new AttrSchema("author",     "string", Required: true, Description: "Author of the briefing."),
                new AttrSchema("recipient",  "string", Required: true, Description: "Intended recipient role."),
            }));
    }
}

internal sealed class NoopTestProvider(string id, params string[] deps) : IMetaDataTypeProvider
{
    public string Id { get; } = id;
    public IReadOnlyList<string> Dependencies { get; } = deps;
    public void RegisterTypes(TypeRegistry registry) { }
}

/// <summary>
/// Cross-port envelope record surfaced by <see cref="LoadOutcome.Errors"/>.
/// Mirrors the TS <c>ErrorEnvelopeRecord</c> shape so the C# runner can do
/// the same per-error envelope assertion the TS runner does. FR5d —
/// <c>Referrer</c> and <c>Target</c> are populated for <c>format=resolved</c>
/// envelopes (reference-resolution errors).
/// </summary>
public sealed record ErrorEnvelopeRecord(
    string Code,
    string Format,
    IReadOnlyList<string> Files,
    string? JsonPath,
    string? Referrer = null,
    string? Target = null);

/// <summary>
/// Result of loading a fixture's input directory.
/// </summary>
/// <param name="Tree">The loaded metadata tree.</param>
/// <param name="ErrorCodes">Error code strings collected during loading.</param>
/// <param name="Warnings">Warning strings collected during loading.</param>
/// <param name="Errors">Full envelope records (FR5a / ADR-0009). Populated alongside <see cref="ErrorCodes"/>.</param>
/// <param name="WarningEnvelopes">
/// FR5c-finalize — full warning envelopes (same shape as <see cref="Errors"/>).
/// When present AND the fixture's expected-errors.json declares envelope-shape
/// warnings, the runner asserts per-warning envelope alignment (mirrors the
/// error-side assertion). When absent, the runner falls back to comparing
/// <see cref="Warnings"/> as a flat string list against expected-warnings.json.
/// </param>
public sealed record LoadOutcome(
    MetaRoot Tree,
    IReadOnlyList<string> ErrorCodes,
    IReadOnlyList<string> Warnings,
    IReadOnlyList<ErrorEnvelopeRecord> Errors,
    IReadOnlyList<ErrorEnvelopeRecord> WarningEnvelopes);

/// <summary>
/// Adapter that bridges the conformance test infrastructure to the C# MetaObjects library.
/// </summary>
public static class ConformanceAdapter
{
    /// <summary>
    /// Provider-id → provider. The fixture corpus names providers by stable id;
    /// this maps them to provider objects. An unknown id throws (parity with the TS adapter).
    /// Test-only providers (provider-extension-* fixtures) live alongside the
    /// shipped ones — they are guarded by the fixture's providers.json so they
    /// never feed a production code path.
    /// </summary>
    private static readonly IReadOnlyDictionary<string, IMetaDataTypeProvider> Providers =
        new Dictionary<string, IMetaDataTypeProvider>(StringComparer.Ordinal)
        {
            ["metaobjects-core-types"]    = CoreTypes.CoreTypesProvider,
            ["metaobjects-documentation"] = DocumentationTypes.DocTypesProvider,
            // R6 Plan 2b — the shared db-attr fixtures (e.g. @dbColumnType pairing)
            // declare a "metaobjects-db" provider. In C# the physical-attr handling +
            // @dbColumnType pairing validation live in the always-on loader passes
            // (ValidationPasses.ValidateDbColumnType), not a separate registered
            // provider, so the id maps to a no-op composition entry whose only job is
            // to resolve the fixture's providers.json. The validation fires regardless.
            ["metaobjects-db"]            = new NoopTestProvider("metaobjects-db", "metaobjects-core-types"),
            // Test-only — provider-extension-* fixtures.
            ["example-template-briefing"] = new ExampleTemplateBriefingProvider(),
            ["cycle-a"]                   = new NoopTestProvider("cycle-a", "cycle-b"),
            ["cycle-b"]                   = new NoopTestProvider("cycle-b", "cycle-a"),
            ["depends-on-missing"]        = new NoopTestProvider("depends-on-missing", "does-not-exist"),
            ["duplicate-x"]               = new NoopTestProvider("duplicate-x"),
            // Same `.Id` as duplicate-x — surfaces ERR_PROVIDER_DUPLICATE_ID at compose time.
            ["duplicate-x-clone"]         = new NoopTestProvider("duplicate-x"),
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

        // Provider composition errors (duplicate id / missing dep / cycle) are
        // first-class fixture outcomes: surface them as a code-only LoadOutcome
        // so the cross-port runner can compare expected-errors.json directly.
        TypeRegistry registry;
        try
        {
            registry = Provider.ComposeRegistry(resolved);
        }
        catch (MetaModelException ex)
        {
            var codeStr = ex.Code.ToString();
            var compErr = new ErrorEnvelopeRecord(codeStr, "code", Array.Empty<string>(), null);
            return new LoadOutcome(
                Tree: null!,
                ErrorCodes: new[] { codeStr },
                Warnings: Array.Empty<string>(),
                Errors: new[] { compErr },
                WarningEnvelopes: Array.Empty<ErrorEnvelopeRecord>());
        }
        var result = MetaDataLoader.FromDirectory(inputDir, registry);

        // FR5a — surface the full envelope per error. Normalize files[] to
        // be relative to inputDir (the harness's portable file token).
        var envelopes = result.Errors.Select(e => BuildEnvelope(e, inputDir)).ToList();

        // FR5c-finalize — surface warning envelopes (same envelope shape as
        // errors). The loader's EnvelopeWarnings list carries envelope-shaped
        // warnings (e.g. WARN_DUPLICATE_DECLARATION) with full LoaderWarning
        // provenance. Mirror the error-side normalization so the cross-port
        // runner can assert per-warning envelope alignment.
        var warningEnvelopes = (result.EnvelopeWarnings ?? Array.Empty<LoaderWarning>())
            .Select(w => BuildWarningEnvelope(w, inputDir))
            .ToList();

        return new LoadOutcome(
            result.Root,
            result.Errors.Select(e => e.Code.ToString()).ToList(),
            result.Warnings.ToList(),
            envelopes,
            warningEnvelopes);
    }

    private static ErrorEnvelopeRecord BuildEnvelope(MetaError err, string inputDir) =>
        BuildEnvelopeFromSource(err.Code.ToString(), err.Envelope, inputDir);

    private static ErrorEnvelopeRecord BuildWarningEnvelope(LoaderWarning w, string inputDir) =>
        BuildEnvelopeFromSource(w.Code, w.Source, inputDir);

    private static ErrorEnvelopeRecord BuildEnvelopeFromSource(string code, ErrorSource? envelope, string inputDir)
    {
        IReadOnlyList<string> Rel(IEnumerable<string> files) =>
            files.Select(f => RelativizeFile(f, inputDir)).ToList();
        return envelope switch
        {
            JsonSource js     => new ErrorEnvelopeRecord(code, "json",     Rel(js.Files), js.JsonPath),
            YamlSource ys     => new ErrorEnvelopeRecord(code, "yaml",     Rel(ys.Files), ys.JsonPath),
            MergedSource ms   => new ErrorEnvelopeRecord(code, "merged",   Rel(ms.Files), ms.JsonPath),
            // FR5d — surface Referrer + Target so the cross-port runner can assert them.
            ResolvedSource rs => new ErrorEnvelopeRecord(code, "resolved", Rel(rs.Files), rs.JsonPath, rs.Referrer, rs.Target),
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
