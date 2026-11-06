// FR-023 — the publisher's half of a shared model: the flattened artifact and the manifest that pins it,
// the pair a consumer's `meta deps sync` copies into its own repo and verifies (design §2.2, §3.2, §3.5).
//
// Mirrors codegen-ts/src/shared-model/build-shared-model.ts and the Java com.metaobjects.config.SharedModel;
// the shared corpus fixtures/shared-model-conformance/ pins the bytes and the refusals.
//
// Two stages, both pure of the run, and both in the package on purpose. A generator an application owns
// (`dotnet meta eject shared-model`) decides which source files may contribute and which version is
// published, and calls these for everything a consumer checks: what is selected, that the selection is
// closed, the document's bytes, the hash over them, and the manifest's shape and file names. An owned
// copy that changed any of those would publish an artifact a consumer's sync refuses, or worse, accepts
// and cannot load, so they are not in the copy.
//
//   Build  — standalone strict load of the files with the publisher's own providers; select top-level
//            nodes (never requirement.* or template.*) by include / exclude; check the selection is closed
//            over `extends` and every ref-bearing attribute; serialize; re-load the document with the
//            library's own providers only.
//   Render — <name>.metaobjects.json and metaobjects.pkg.json, the manifest carrying the sha256 of the
//            artifact's bytes.
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using MetaObjects.Loader;
using MetaObjects.Meta;

namespace MetaObjects.Config;

/// <summary>Why a publisher refused to publish; the corpus's <c>expectRefusal.reason</c>.</summary>
public enum SharedModelRefusalReason
{
    /// <summary>The scope selected no node.</summary>
    EmptySelection,

    /// <summary>A selected node refers to one that is not selected.</summary>
    NotClosed,

    /// <summary>The artifact needs vocabulary only the publisher's own providers register.</summary>
    NonCoreVocabulary,
}

/// <summary>One <c>(referrer, target)</c> resolution-key pair a selection is not closed over.</summary>
public sealed record SharedModelPair(string Referrer, string Target);

/// <summary>A selection that cannot be published; carries the classified reason and, for not-closed, every pair.</summary>
public sealed class SharedModelRefusal(
    SharedModelRefusalReason reason, string message, IReadOnlyList<SharedModelPair> pairs)
    : InvalidOperationException(message)
{
    /// <summary>The classified reason.</summary>
    public SharedModelRefusalReason Reason { get; } = reason;

    /// <summary>Sorted by referrer then target (ordinal); empty unless <see cref="SharedModelRefusalReason.NotClosed"/>.</summary>
    public IReadOnlyList<SharedModelPair> Pairs { get; } = pairs;

    /// <summary>The corpus spelling of <see cref="Reason"/>.</summary>
    public string ReasonId => Reason switch
    {
        SharedModelRefusalReason.EmptySelection => "empty-selection",
        SharedModelRefusalReason.NotClosed => "not-closed",
        _ => "non-core-vocabulary",
    };
}

/// <summary>What to publish.</summary>
/// <param name="Name">The dependency key a consumer will sync under; also the artifact's basename.</param>
/// <param name="Files">The publisher's own source files that may contribute, loaded standalone.</param>
/// <param name="Include">Scope patterns (the same grammar as <c>scope</c>); empty selects everything.</param>
/// <param name="Exclude">Applied after <paramref name="Include"/>.</param>
/// <param name="Providers">The publisher's own vocabulary providers, so its extra attributes load as they
/// did for the project's main load; empty is the library's own vocabulary.</param>
public sealed record SharedModelInput(
    string Name,
    IReadOnlyList<string> Files,
    IReadOnlyList<string>? Include = null,
    IReadOnlyList<string>? Exclude = null,
    IReadOnlyList<IMetaDataTypeProvider>? Providers = null);

/// <summary>
/// A selection that passed every check, serialized. The document is exactly the bytes that were re-loaded
/// with the library's vocabulary, and the manifest's hash is taken over them.
/// </summary>
/// <param name="Name">The dependency key.</param>
/// <param name="Document">The canonical-JSON <c>metadata.root</c> document: the artifact's bytes.</param>
/// <param name="Packages">The metadata packages the selection spans, sorted.</param>
/// <param name="Nodes">The resolution key of every selected top-level node, sorted.</param>
public sealed record SharedModelBuilt(
    string Name, string Document, IReadOnlyList<string> Packages, IReadOnlyList<string> Nodes);

/// <summary>The two files a shared model is published as.</summary>
public sealed record SharedModelFiles(string ArtifactPath, string Artifact, string ManifestPath, string Manifest);

/// <summary>The FR-023 publisher.</summary>
public static class SharedModel
{
    /// <summary>The manifest schema's own version, distinct from <c>metamodelVersion</c>.</summary>
    private const int ManifestSchemaVersion = 1;

    private static readonly JsonSerializerOptions ManifestOptions = new()
    {
        WriteIndented = true,
        // JSON.stringify does not escape <, >, & or '. Match that.
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    /// <summary><c>&lt;name&gt;.metaobjects.json</c>: the artifact's file name, as <c>meta deps sync</c> reads it.</summary>
    public static string ArtifactFileName(string name) => name + DependencyFiles.ArtifactSuffix;

    /// <summary>
    /// Load the files standalone, select by include / exclude, and return the selection as a checked,
    /// serialized shared model (design §4.3 steps 1 to 5).
    /// </summary>
    /// <exception cref="SharedModelRefusal">The selection is empty, is not closed, or needs vocabulary a
    /// consumer's toolchain does not ship.</exception>
    /// <exception cref="MetaModelException">The files do not load.</exception>
    public static SharedModelBuilt Build(SharedModelInput input)
    {
        // Step 1: standalone strict load, the publisher's own providers.
        var root = Load(input.Providers, input.Files.Select(f => (IMetaDataSource)new FileSource(f)).ToList()).Root;

        // Step 2: select. The root has no super chain (ADR-0039 sanctioned own read).
        var scope = Scope.CompileScope(input.Include, input.Exclude);
        var selected = root.OwnChildren()
            .Where(n => n.Type != TYPE_REQUIREMENT && n.Type != TYPE_TEMPLATE)
            .Where(n => Scope.MatchesScope(n.ResolutionKey(), scope))
            .ToList();
        if (selected.Count == 0)
        {
            throw new SharedModelRefusal(SharedModelRefusalReason.EmptySelection,
                $"shared-model \"{input.Name}\": selected no nodes (include/exclude, always excluding " +
                "requirement.* and template.*) - nothing to publish. Check `include`.", []);
        }

        // Step 3: closure.
        var selectedKeys = selected.Select(n => n.ResolutionKey()).ToHashSet(StringComparer.Ordinal);
        var failures = CheckClosure(root, selected, selectedKeys);
        if (failures.Count > 0)
        {
            var lines = string.Concat(failures.Select(p => $"\n  {p.Referrer} -> {p.Target}"));
            throw new SharedModelRefusal(SharedModelRefusalReason.NotClosed,
                $"shared-model \"{input.Name}\": the selection is not closed - these references point " +
                "outside it; include it or exclude the referrer:" + lines, failures);
        }

        // Step 4: serialize (sorted by resolution key).
        var document = SerializerJson.SerializeSharedDocument(selected);

        // Step 5: re-load with the library's own providers only. A consumer loads the artifact with ITS
        // providers, never the publisher's, so an export needing publisher-only vocabulary fails HERE.
        try
        {
            Load(null, [new InMemoryStringSource(document, ArtifactFileName(input.Name))]);
        }
        catch (Exception e)
        {
            throw new SharedModelRefusal(SharedModelRefusalReason.NonCoreVocabulary,
                $"shared-model \"{input.Name}\": the export needs a provider this toolchain does not " +
                $"ship; Phase 1 exports must load with core vocabulary: {e.Message}", []);
        }

        var packages = selected.Select(n => DependencyResolver.PackageOf(n.ResolutionKey()))
            .Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal).ToList();
        var nodes = selected.Select(n => n.ResolutionKey()).Order(StringComparer.Ordinal).ToList();
        return new SharedModelBuilt(input.Name, document, packages, nodes);
    }

    /// <summary>
    /// The artifact and the manifest that pins it (design §4.3 step 6, §3.2): the manifest names the
    /// artifact and carries the sha256 of its bytes, so the pair is rendered together and never one
    /// without the other.
    /// </summary>
    public static SharedModelFiles Render(SharedModelBuilt model, string version)
    {
        var artifactPath = ArtifactFileName(model.Name);
        var manifest = new JsonObject
        {
            ["schema_version"] = ManifestSchemaVersion,
            ["name"] = model.Name,
            ["version"] = version,
            ["metamodelVersion"] = RegistryManifest.MetamodelVersion,
            ["artifact"] = artifactPath,
            ["integrity"] = DependencyResolver.Sha256Integrity(Encoding.UTF8.GetBytes(model.Document)),
            ["packages"] = new JsonArray(model.Packages.Select(p => (JsonNode?)JsonValue.Create(p)).ToArray()),
            ["nodes"] = new JsonArray(model.Nodes.Select(p => (JsonNode?)JsonValue.Create(p)).ToArray()),
        };
        return new SharedModelFiles(
            artifactPath, model.Document, DependencyResolver.ManifestFile,
            manifest.ToJsonString(ManifestOptions) + "\n");
    }

    private static LoadResult Load(IReadOnlyList<IMetaDataTypeProvider>? providers, IReadOnlyList<IMetaDataSource> sources)
    {
        var registry = Provider.ComposeRegistry(ProviderLoader.Compose(providers));
        var result = new MetaDataLoader(registry, freeze: true, strict: true).Load(sources);
        if (result.Errors.Count > 0)
            throw new MetaModelException(result.Errors[0].Message, result.Errors[0].Code);
        return result;
    }

    // ------------------------------------------------------------------------------------
    // closure

    /// <summary>Depth-first walk of a node and its OWN descendants, node itself first. ADR-0039
    /// sanctioned own-only case: the shared document emits each selected node's OWN layer only
    /// (<c>extends</c> preserved, not flattened), so the closure check walks exactly what will be emitted.</summary>
    private static void WalkOwn(MetaData node, List<MetaData> output)
    {
        output.Add(node);
        foreach (var child in node.OwnChildren()) WalkOwn(child, output);
    }

    private static List<SharedModelPair> CheckClosure(
        MetaData root, IReadOnlyList<MetaData> selected, HashSet<string> selectedKeys)
    {
        var seen = new HashSet<SharedModelPair>();
        var pairs = new List<SharedModelPair>();
        var refBearingNames = NamingRefs.RefBearingAttrNames.Order(StringComparer.Ordinal).ToList();
        foreach (var top in selected)
        {
            var referrerKey = top.ResolutionKey();
            // R3: every own reference of a node resolves in the package of the top-level node that declares it.
            var referrerPkg = NamingRefs.EffectivePackageOf(top);
            var walk = new List<MetaData>();
            WalkOwn(top, walk);
            foreach (var node in walk)
            {
                var candidates = new List<string>();
                if ((node.AuthoredSuperRef ?? node.SuperRef) is { } superRef) candidates.Add(superRef);
                // ADR-0039 sanctioned own-only case: an INHERITED ref-bearing attr belongs to the base
                // node's own layer and is checked when the base itself is walked.
                foreach (var name in refBearingNames)
                {
                    if (node.OwnAttr(name) is string s) candidates.Add(s);
                }
                foreach (var raw in candidates)
                {
                    var target = NamingRefs.ResolveObjectRef(root, NamingRefs.SplitChildTail(raw).Owner, referrerPkg);
                    if (target is null) continue; // already validated at load: defensive only
                    var targetKey = target.ResolutionKey();
                    if (selectedKeys.Contains(targetKey)) continue;
                    var pair = new SharedModelPair(referrerKey, targetKey);
                    if (seen.Add(pair)) pairs.Add(pair);
                }
            }
        }
        pairs.Sort((a, b) =>
        {
            var byReferrer = string.CompareOrdinal(a.Referrer, b.Referrer);
            return byReferrer != 0 ? byReferrer : string.CompareOrdinal(a.Target, b.Target);
        });
        return pairs;
    }
}
