// FR-037 R1 — the @mutability tightening order is load-bearing, so it is pinned.
//
// ValidationPasses.MutabilityRank() is an INDEX comparison over
// FieldConstants.MUTABILITY_MODES ("declaration order IS the tightening order", as the
// constant's own doc comment says), so reordering that array silently inverts "may only
// tighten" with nothing to catch it.
//
// The shared conformance corpus cannot stand in for this. Its inheritance fixtures pair
// only readOnly with readWrite — the two ENDPOINTS — so a full reversal is caught but a
// reorder that moves ONLY writeOnce is not. The corpus fixture
// error-field-mutability-downgrade-writeonce closes the behavioural half cross-port; this
// closes the structural half in the port whose rank function reads the array.
//
// Mirrors the TypeScript pin (metadata/test/fr037-field-mutability.test.ts), which was the
// only such pin in any port until now.

using MetaObjects.Core.Field;
using Xunit;

namespace MetaObjects.Conformance.Tests;

public class Fr037MutabilityOrderTests
{
    [Fact]
    public void DeclarationOrderIsTheTighteningOrder()
    {
        // Loosest first. The downgrade rule is rank(child) >= rank(parent), so this
        // order IS the rule.
        Assert.Equal(
            new[] { "readWrite", "writeOnce", "readOnly" },
            FieldConstants.MUTABILITY_MODES);
    }

    [Fact]
    public void ModeSpellings()
    {
        // The wire spellings travel cross-port; a typo here is a silent divergence.
        Assert.Equal("readWrite", FieldConstants.MUTABILITY_READ_WRITE);
        Assert.Equal("writeOnce", FieldConstants.MUTABILITY_WRITE_ONCE);
        Assert.Equal("readOnly", FieldConstants.MUTABILITY_READ_ONLY);
    }

    /// <summary>
    /// The specific relationship the corpus never exercises. Stated as an explicit rank
    /// comparison rather than inferred from the array above, so a future change that keeps
    /// the array's CONTENTS but alters how rank is derived still fails here.
    /// </summary>
    [Fact]
    public void WriteOnceRanksBetweenTheTwoEndpoints()
    {
        int readWrite = System.Array.IndexOf(FieldConstants.MUTABILITY_MODES, FieldConstants.MUTABILITY_READ_WRITE);
        int writeOnce = System.Array.IndexOf(FieldConstants.MUTABILITY_MODES, FieldConstants.MUTABILITY_WRITE_ONCE);
        int readOnly = System.Array.IndexOf(FieldConstants.MUTABILITY_MODES, FieldConstants.MUTABILITY_READ_ONLY);
        Assert.True(readWrite < writeOnce, "readWrite must rank looser than writeOnce");
        Assert.True(writeOnce < readOnly, "writeOnce must rank looser than readOnly");
    }
}
