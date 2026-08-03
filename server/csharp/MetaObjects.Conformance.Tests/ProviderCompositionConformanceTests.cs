// ProviderCompositionConformanceTests — C# port runner.
//
// Five registry/provider error codes are Tier-1 cross-port invariants that the
// metadata-input -> error corpus cannot reach: they are triggered by HOW
// providers are composed and sealed, not by any metadata document. This runner
// gates them from the shared corpus at fixtures/provider-composition-conformance/.
//
// Each port supplies the SAME canonical named-provider set (see the corpus
// README). A manifest names providers by id; the runner maps names -> provider
// objects, composes, and asserts the surfaced Code. The registry-sealed scenario
// composes, seals, then runs a probe provider's RegisterTypes against the sealed
// registry.

using System.Text.Json;
using MetaObjects;
using MetaObjects.Core.Attr;
using MetaObjects.Loader;
using MetaObjects.Meta;
using MetaObjects.Presentation.View;
using MetaObjects.Shared;
using Xunit;

namespace MetaObjects.Conformance.Tests;

// --- Canonical named-provider set (test-only; identical id/deps/behavior cross-port) ---

/// <summary>Registers a fresh test-only type carrying a single string attr.</summary>
internal sealed class AttrConflictBaseProvider : IMetaDataTypeProvider
{
    public const string ConflictSubType = "compositionprobe";
    public const string ConflictAttr = "conflictAttr";

    public string Id => "attr-conflict-base";
    public IReadOnlyList<string> Dependencies => System.Array.Empty<string>();

    public void RegisterTypes(TypeRegistry registry)
    {
        registry.Register(new TypeDefinition(
            typeId: new TypeId("template", ConflictSubType),
            description: "Test-only — provider-composition conflict probe.",
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
                new AttrSchema(ConflictAttr, "string", Required: false, Description: "Conflict probe attr."),
            }));
    }
}

/// <summary>Extends the base's type, redefining the same attr name -> attr conflict.</summary>
internal sealed class AttrConflictClashProvider : IMetaDataTypeProvider
{
    public string Id => "attr-conflict-clash";
    public IReadOnlyList<string> Dependencies => new[] { "attr-conflict-base" };

    public void RegisterTypes(TypeRegistry registry)
    {
        registry.Extend(
            "template",
            AttrConflictBaseProvider.ConflictSubType,
            attributes: new List<AttrSchema>
            {
                new AttrSchema(AttrConflictBaseProvider.ConflictAttr, "string", Required: false, Description: "Redefined — collides."),
            });
    }
}

/// <summary>Attempts a mutating registration — throws against a sealed registry.</summary>
internal sealed class SealProbeProvider : IMetaDataTypeProvider
{
    public string Id => "seal-probe";
    public IReadOnlyList<string> Dependencies => System.Array.Empty<string>();

    public void RegisterTypes(TypeRegistry registry)
    {
        registry.Register(new TypeDefinition(
            typeId: new TypeId("template", "sealprobe"),
            description: "Test-only — sealed-registry mutation probe.",
            childRules: new List<ChildRule>(),
            factory: (typeId, name) => new MetaTemplate(typeId, name),
            attributes: new List<AttrSchema>()));
    }
}

/// <summary>
/// #265 `compose-load/` canonical named provider. Extends `view.currency` (a
/// SPEC-DECLARED CORE subtype the library's own core-types provider registers)
/// with a new `decimals` int attr. Deliberately NO dependencies — see the corpus
/// README "Canonical named provider `extend-spec-subtype`" for why (cross-port
/// id/dep parity vs. the `composeWithCore` ordering contract).
/// </summary>
internal sealed class ExtendSpecSubtypeProvider : IMetaDataTypeProvider
{
    public string Id => "extend-spec-subtype";
    public IReadOnlyList<string> Dependencies => System.Array.Empty<string>();

    public void RegisterTypes(TypeRegistry registry)
    {
        registry.Extend(
            BaseTypes.TYPE_VIEW,
            ViewConstants.VIEW_SUBTYPE_CURRENCY,
            attributes: new List<AttrSchema>
            {
                new AttrSchema(
                    "decimals",
                    AttrConstants.ATTR_SUBTYPE_INT,
                    Required: false,
                    Description: "Test-only — #265 compose-load probe attr."),
            });
    }
}

public sealed class ProviderCompositionConformanceTests
{
    private static readonly IReadOnlyDictionary<string, IMetaDataTypeProvider> Providers =
        new Dictionary<string, IMetaDataTypeProvider>(System.StringComparer.Ordinal)
        {
            ["duplicate-x"]         = new NoopTestProvider("duplicate-x"),
            // Same Id as duplicate-x — surfaces ERR_PROVIDER_DUPLICATE_ID at compose time.
            ["duplicate-x-clone"]   = new NoopTestProvider("duplicate-x"),
            ["depends-on-missing"]  = new NoopTestProvider("depends-on-missing", "does-not-exist"),
            ["cycle-a"]             = new NoopTestProvider("cycle-a", "cycle-b"),
            ["cycle-b"]             = new NoopTestProvider("cycle-b", "cycle-a"),
            ["attr-conflict-base"]  = new AttrConflictBaseProvider(),
            ["attr-conflict-clash"] = new AttrConflictClashProvider(),
            ["seal-probe"]          = new SealProbeProvider(),
            ["extend-spec-subtype"] = new ExtendSpecSubtypeProvider(),
        };

    // Flat-corpus (error-code) manifest shape — unchanged.
    // #265 compose-load manifest shape — see fixtures/provider-composition-conformance/README.md
    // "The `compose-load/` subdir". A manifest never carries both shapes; ExpectedError is
    // OPTIONAL (null) on a compose-load manifest, and ExpectAttrs/Metadata/ExpectErrors are
    // OPTIONAL (null) on a flat-corpus manifest — the two runner loops below dispatch on which
    // fields are present.
    private sealed record ComposeLoadExpectAttrs(string Type, string SubType, string[] Contains);

    private sealed record Manifest(
        string[] Providers,
        string? ExpectedError = null,
        string? SealThenRegister = null,
        bool? ComposeWithCore = null,
        ComposeLoadExpectAttrs? ExpectAttrs = null,
        JsonElement? Metadata = null,
        string[]? ExpectErrors = null);

    private static string CorpusRootPath()
    {
        var env = System.Environment.GetEnvironmentVariable("METAOBJECTS_PROVIDER_COMPOSITION_CORPUS");
        if (!string.IsNullOrEmpty(env) && Directory.Exists(env)) return env;

        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir != null)
        {
            var candidate = Path.Combine(dir.FullName, "fixtures", "provider-composition-conformance");
            if (Directory.Exists(candidate)) return candidate;
            dir = dir.Parent;
        }
        throw new DirectoryNotFoundException(
            "could not locate fixtures/provider-composition-conformance from " + AppContext.BaseDirectory);
    }

    public static IEnumerable<object[]> ManifestFiles()
    {
        foreach (var file in Directory.GetFiles(CorpusRootPath(), "*.json").OrderBy(f => f, System.StringComparer.Ordinal))
            yield return new object[] { Path.GetFileName(file) };
    }

    private static IMetaDataTypeProvider Resolve(string id) =>
        Providers.TryGetValue(id, out var p)
            ? p
            : throw new System.ArgumentException($"Unknown named provider \"{id}\" in provider-composition corpus");

    [Fact]
    public void CorpusIsNonEmpty()
    {
        Assert.NotEmpty(ManifestFiles());
    }

    [Theory]
    [MemberData(nameof(ManifestFiles))]
    public void ProviderComposition(string fileName)
    {
        var opts = new JsonSerializerOptions { PropertyNameCaseInsensitive = true };
        var manifest = JsonSerializer.Deserialize<Manifest>(
            File.ReadAllText(Path.Combine(CorpusRootPath(), fileName)), opts)!;

        // Flat-corpus manifests always carry expectedError (the old shape); guard + narrow
        // rather than a non-null assertion so a malformed fixture fails loud.
        string? expectedError = manifest.ExpectedError;
        if (expectedError is null)
        {
            throw new System.InvalidOperationException(
                $"flat-corpus manifest \"{fileName}\" is missing required \"expectedError\"");
        }

        var resolved = manifest.Providers.Select(Resolve).ToList();

        if (manifest.SealThenRegister != null)
        {
            // Compose (must succeed), seal, then run the probe against the sealed registry.
            var registry = Provider.ComposeRegistry(resolved);
            registry.Seal();
            var probe = Resolve(manifest.SealThenRegister);
            var sealedEx = Assert.Throws<MetaModelException>(() => probe.RegisterTypes(registry));
            Assert.Equal(expectedError, sealedEx.Code.ToString());
            return;
        }

        // Ordinary scenario: the compose call itself throws.
        var ex = Assert.Throws<MetaModelException>(() => Provider.ComposeRegistry(resolved));
        Assert.Equal(expectedError, ex.Code.ToString());
    }

    // -----------------------------------------------------------------------
    // #265 `compose-load/` corpus — see fixtures/provider-composition-conformance/
    // README.md "The `compose-load/` subdir". Own directory, own loop: a manifest
    // here never carries `expectedError` / `sealThenRegister` (the flat-corpus shape
    // above); it carries `composeWithCore` / `expectAttrs` / `metadata` /
    // `expectErrors` instead.
    // -----------------------------------------------------------------------

    private static string ComposeLoadCorpusRootPath() =>
        Path.Combine(CorpusRootPath(), "compose-load");

    public static IEnumerable<object[]> ComposeLoadManifestFiles()
    {
        foreach (var file in Directory.GetFiles(ComposeLoadCorpusRootPath(), "*.json").OrderBy(f => f, System.StringComparer.Ordinal))
            yield return new object[] { Path.GetFileName(file) };
    }

    [Fact]
    public void ComposeLoadCorpusIsNonEmpty()
    {
        Assert.NotEmpty(ComposeLoadManifestFiles());
    }

    [Theory]
    [MemberData(nameof(ComposeLoadManifestFiles))]
    public void ProviderCompositionComposeLoad(string fileName)
    {
        var opts = new JsonSerializerOptions { PropertyNameCaseInsensitive = true };
        var manifest = JsonSerializer.Deserialize<Manifest>(
            File.ReadAllText(Path.Combine(ComposeLoadCorpusRootPath(), fileName)), opts)!;

        var named = manifest.Providers.Select(Resolve).ToList();
        List<IMetaDataTypeProvider> providerSet = manifest.ComposeWithCore == true
            ? CoreTypes.LibraryProviders.Concat(named).ToList()
            : named;

        TypeRegistry? registry = null;

        if (manifest.ExpectAttrs is not null)
        {
            registry = Provider.ComposeRegistry(providerSet);
            var declaredNames = registry.AttrsOf(manifest.ExpectAttrs.Type, manifest.ExpectAttrs.SubType)
                .Select(a => a.Name)
                .ToList();
            foreach (string name in manifest.ExpectAttrs.Contains)
            {
                Assert.Contains(name, declaredNames);
            }
        }

        if (manifest.Metadata is JsonElement metadataElement)
        {
            registry ??= Provider.ComposeRegistry(providerSet);
            string doc = metadataElement.GetRawText();
            var loader = new MetaDataLoader(registry, strict: true);
            LoadResult result = loader.Load(new IMetaDataSource[] { new InMemoryStringSource(doc, format: MetaDataFormat.Json) });

            var actualCodes = result.Errors
                .Select(e => e.Code.ToString())
                .OrderBy(c => c, System.StringComparer.Ordinal)
                .ToList();
            var expectedCodes = (manifest.ExpectErrors ?? System.Array.Empty<string>())
                .OrderBy(c => c, System.StringComparer.Ordinal)
                .ToList();
            Assert.Equal(expectedCodes, actualCodes);
        }
    }
}
