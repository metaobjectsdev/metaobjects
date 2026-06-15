// SP-G Registry Conformance — the C# gate.
//
// Composes the C# core registry (the same provider set the loader uses, plus
// the documentation common-attrs provider), emits the canonical registry
// manifest via RegistryManifest.Emit, and asserts it is BYTE-IDENTICAL to the
// single committed canonical, fixtures/registry-conformance/expected-registry.json
// (the TS reference output). A mismatch is a real C# registry divergence — fix
// the C# registration to match the cross-port contract.

using MetaObjects;
using MetaObjects.Core.Documentation;
using Xunit;

namespace MetaObjects.Conformance.Tests;

public class RegistryManifestConformanceTests
{
    [Fact]
    public void Emit_matches_the_committed_cross_port_canonical()
    {
        // The same provider composition that produces the C# loader's registry,
        // plus the documentation provider that registers the common doc attrs
        // (the canonical's commonAttrs section).
        TypeRegistry registry = Provider.ComposeRegistry(new[]
        {
            CoreTypes.CoreTypesProvider,
            // DB-domain field attrs (@column / @db.indexed / @dbColumnType) — Extend over core.
            MetaObjects.Persistence.Db.DbMetaDataProvider.Instance,
            // FR-033 concern providers — UI / prompt attrs re-homed out of core
            // (read spec/metamodel/ui.json + prompt.json). The prompt provider
            // absorbs the @xmlText marker the former TemplateTypesProvider registered.
            MetaObjects.Presentation.Ui.UiMetaDataProvider.Instance,
            MetaObjects.Template.PromptMetaDataProvider.Instance,
            DocumentationTypes.DocTypesProvider,
        });

        string actual = RegistryManifest.Emit(registry);
        string expected = File.ReadAllText(ExpectedRegistryPath());

        // Newline-normalize both sides so a checkout's CRLF can't fail the gate;
        // the contract is logical-vocabulary identity, not line-ending identity.
        string actualNorm = Normalize(actual);
        string expectedNorm = Normalize(expected);

        Assert.True(
            actualNorm == expectedNorm,
            "SP-G registry-conformance gate: the C# registry manifest does NOT match the " +
            "committed cross-port canonical (fixtures/registry-conformance/expected-registry.json). " +
            "Fix the C# registration to match the cross-port contract, or escalate if TS is wrong.\n\n" +
            FirstDiff(expectedNorm, actualNorm));
    }

    // Wave 3b — the in/out boundary is an EXPLICIT classification (a reason
    // category per carve-out), not a bare name-match. Assert the classification
    // is total and self-documenting.
    [Fact]
    public void Every_registered_per_type_attr_is_explicitly_classified()
    {
        TypeRegistry registry = Provider.ComposeRegistry(new[]
        {
            CoreTypes.CoreTypesProvider,
            // DB-domain field attrs (@column / @db.indexed / @dbColumnType) — Extend over core.
            MetaObjects.Persistence.Db.DbMetaDataProvider.Instance,
            // FR-033 concern providers — UI / prompt attrs re-homed out of core
            // (read spec/metamodel/ui.json + prompt.json). The prompt provider
            // absorbs the @xmlText marker the former TemplateTypesProvider registered.
            MetaObjects.Presentation.Ui.UiMetaDataProvider.Instance,
            MetaObjects.Template.PromptMetaDataProvider.Instance,
            DocumentationTypes.DocTypesProvider,
        });

        foreach (TypeId typeId in registry.AllTypes())
        {
            foreach (AttrSchema attr in registry.AttrsOf(typeId.Type, typeId.SubType))
            {
                // Total function — ClassifyPerTypeAttr always returns a defined enum value
                // (Included or a carve-out reason); there is no silent default-include.
                RegistryManifest.ExclusionReason reason = RegistryManifest.ClassifyPerTypeAttr(attr.Name);
                Assert.True(Enum.IsDefined(reason));
            }
        }
    }

    [Fact]
    public void Carve_outs_carry_their_declared_reason_category()
    {
        Assert.Equal(RegistryManifest.ExclusionReason.StructuralKeyword, RegistryManifest.ClassifyPerTypeAttr("extends"));
        Assert.Equal(RegistryManifest.ExclusionReason.StructuralKeyword, RegistryManifest.ClassifyPerTypeAttr("isArray"));
        Assert.Equal(RegistryManifest.ExclusionReason.NativeBinding, RegistryManifest.ClassifyPerTypeAttr("object"));
        Assert.Equal(RegistryManifest.ExclusionReason.NativeBinding, RegistryManifest.ClassifyPerTypeAttr("objectAdapter"));
        Assert.Equal(RegistryManifest.ExclusionReason.CommonAttrDup, RegistryManifest.ClassifyPerTypeAttr("description"));
        // A genuinely logical attr is Included.
        Assert.Equal(RegistryManifest.ExclusionReason.Included, RegistryManifest.ClassifyPerTypeAttr("column"));
        Assert.Equal(RegistryManifest.ExclusionReason.Included, RegistryManifest.ClassifyPerTypeAttr("maxLength"));
        // Row classification: the metadata.base anchor + the generic view controls.
        Assert.Equal(RegistryManifest.ExclusionReason.InheritanceAnchor, RegistryManifest.ClassifyTypeSubType("metadata", "base"));
        Assert.Equal(RegistryManifest.ExclusionReason.PresentationOnly, RegistryManifest.ClassifyTypeSubType("view", "dropdown"));
        Assert.Equal(RegistryManifest.ExclusionReason.Included, RegistryManifest.ClassifyTypeSubType("view", "currency"));
    }

    private static string Normalize(string s) => s.Replace("\r\n", "\n");

    private static string ExpectedRegistryPath()
    {
        // CorpusRoot resolves <repo>/fixtures/conformance; the registry canonical
        // is its sibling <repo>/fixtures/registry-conformance/expected-registry.json.
        string fixturesDir = Path.GetDirectoryName(CorpusRoot.Path)!;
        return Path.Combine(fixturesDir, "registry-conformance", "expected-registry.json");
    }

    /// <summary>Produce a compact first-difference report to make a failure actionable.</summary>
    private static string FirstDiff(string expected, string actual)
    {
        string[] e = expected.Split('\n');
        string[] a = actual.Split('\n');
        int n = Math.Max(e.Length, a.Length);
        for (int i = 0; i < n; i++)
        {
            string el = i < e.Length ? e[i] : "<EOF>";
            string al = i < a.Length ? a[i] : "<EOF>";
            if (el != al)
            {
                return $"First difference at line {i + 1}:\n  expected: {el}\n  actual:   {al}";
            }
        }
        return "(no line-level difference found — check trailing bytes)";
    }
}
