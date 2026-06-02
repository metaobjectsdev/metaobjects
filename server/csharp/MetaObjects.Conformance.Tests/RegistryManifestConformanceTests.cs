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
