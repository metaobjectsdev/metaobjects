// Issue #368 — direct unit tests for the reference-resolution ladder
// (MetaObjects.Core.Relationship.RelationshipReferences).
//
// C# port of the TS reference suite
// (server/typescript/packages/metadata/test/resolve-relationship-reference.test.ts)
// and its Python port (server/python/tests/unit/test_relationship_references.py) —
// exercises ReferenceCandidatesFor / ResolveRelationshipReference directly against
// a loaded model, rather than only through the loader's error output (see
// Issue368RelationshipReferenceValidationTests.cs for the loader-integration tests
// covering rule (d) / rule (e)).

using MetaObjects.Core.Relationship;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Conformance.Tests;

public class Issue368RelationshipReferenceLadderTests
{
    private static LoadResult LoadInline(string json) =>
        new MetaDataLoader().Load([new InMemoryStringSource(json, id: "inline.json")]);

    private const string MatchModel = """
    { "metadata.root": { "package": "repro", "children": [
      { "object.entity": { "name": "Team", "children": [
        { "field.long": { "name": "id" } },
        { "identity.primary": { "name": "id", "@fields": ["id"] } }
      ]}},
      { "object.entity": { "name": "Match", "children": [
        { "field.long": { "name": "id" } },
        { "field.long": { "name": "homeTeamId" } },
        { "field.long": { "name": "awayTeamId" } },
        { "identity.primary": { "name": "id", "@fields": ["id"] } },
        { "identity.reference": { "name": "homeTeamRef", "@fields": ["homeTeamId"], "@references": "Team" } },
        { "relationship.association": { "name": "homeTeam", "@objectRef": "Team", "@cardinality": "one" } },
        { "identity.reference": { "name": "awayTeamRef", "@fields": ["awayTeamId"], "@references": "Team" } },
        { "relationship.association": { "name": "awayTeam", "@objectRef": "Team", "@cardinality": "one" } }
      ]}}
    ]}}
    """;

    private static MetaObject LoadMatch()
    {
        var result = LoadInline(MatchModel);
        Assert.Empty(result.Errors);
        return result.Root.FindObject("Match")!;
    }

    [Fact]
    public void Enumerates_every_candidate_reference_for_the_target()
    {
        var candidates = RelationshipReferences.ReferenceCandidatesFor(LoadMatch(), "Team");
        Assert.Equal(["homeTeamRef", "awayTeamRef"], candidates.Select(c => c.Name));
    }

    [Fact]
    public void Name_pairing_resolves_each_association_to_its_own_reference()
    {
        var match = LoadMatch();
        Assert.Equal("homeTeamRef", RelationshipReferences.ResolveRelationshipReference(match, "homeTeam", "Team")?.Name);
        Assert.Equal("awayTeamRef", RelationshipReferences.ResolveRelationshipReference(match, "awayTeam", "Team")?.Name);
    }

    [Fact]
    public void Source_ref_field_wins_over_name_pairing()
    {
        var match = LoadMatch();
        Assert.Equal(
            "awayTeamRef",
            RelationshipReferences.ResolveRelationshipReference(match, "homeTeam", "Team", "awayTeamId")?.Name);
    }

    [Fact]
    public void A_single_candidate_resolves_regardless_of_name()
    {
        const string doc = """
        { "metadata.root": { "package": "repro", "children": [
          { "object.entity": { "name": "Team", "children": [
            { "field.long": { "name": "id" } },
            { "identity.primary": { "name": "id", "@fields": ["id"] } }
          ]}},
          { "object.entity": { "name": "Match", "children": [
            { "field.long": { "name": "id" } },
            { "field.long": { "name": "winnerFk" } },
            { "identity.primary": { "name": "id", "@fields": ["id"] } },
            { "identity.reference": { "name": "anythingAtAll", "@fields": ["winnerFk"], "@references": "Team" } },
            { "relationship.association": { "name": "champion", "@objectRef": "Team", "@cardinality": "one" } }
          ]}}
        ]}}
        """;
        var result = LoadInline(doc);
        Assert.Empty(result.Errors);
        var match = result.Root.FindObject("Match")!;
        Assert.Equal("anythingAtAll", RelationshipReferences.ResolveRelationshipReference(match, "champion", "Team")?.Name);
    }

    [Fact]
    public void Unpairable_names_return_null_rather_than_guessing()
    {
        // #368 rule (e) flags this fixture as a load error -- it's the exact
        // ambiguity the ladder returning null exists to surface. Load with the
        // merge/validation pipeline still run (errors non-empty is expected here),
        // then assert the ladder's return value directly.
        const string doc = """
        { "metadata.root": { "package": "repro", "children": [
          { "object.entity": { "name": "Team", "children": [
            { "field.long": { "name": "id" } },
            { "identity.primary": { "name": "id", "@fields": ["id"] } }
          ]}},
          { "object.entity": { "name": "Match", "children": [
            { "field.long": { "name": "id" } },
            { "field.long": { "name": "alphaFk" } },
            { "field.long": { "name": "betaFk" } },
            { "identity.primary": { "name": "id", "@fields": ["id"] } },
            { "identity.reference": { "name": "alphaRef", "@fields": ["alphaFk"], "@references": "Team" } },
            { "identity.reference": { "name": "betaRef", "@fields": ["betaFk"], "@references": "Team" } },
            { "relationship.association": { "name": "winner", "@objectRef": "Team", "@cardinality": "one" } }
          ]}}
        ]}}
        """;
        var result = LoadInline(doc);
        Assert.Equal([ErrorCode.ERR_INVALID_RELATIONSHIP], result.Errors.Select(e => e.Code));
        var match = result.Root.FindObject("Match")!;
        Assert.Null(RelationshipReferences.ResolveRelationshipReference(match, "winner", "Team"));
    }

    [Fact]
    public void Suffix_stripping_never_applies_to_the_relationship_name()
    {
        // "valid" must NOT be stripped to "val" and pair with valRef.
        const string doc = """
        { "metadata.root": { "package": "repro", "children": [
          { "object.entity": { "name": "Team", "children": [
            { "field.long": { "name": "id" } },
            { "identity.primary": { "name": "id", "@fields": ["id"] } }
          ]}},
          { "object.entity": { "name": "Match", "children": [
            { "field.long": { "name": "id" } },
            { "field.long": { "name": "valFk" } },
            { "field.long": { "name": "otherFk" } },
            { "identity.primary": { "name": "id", "@fields": ["id"] } },
            { "identity.reference": { "name": "valRef", "@fields": ["valFk"], "@references": "Team" } },
            { "identity.reference": { "name": "otherRef", "@fields": ["otherFk"], "@references": "Team" } },
            { "relationship.association": { "name": "valid", "@objectRef": "Team", "@cardinality": "one" } }
          ]}}
        ]}}
        """;
        var result = LoadInline(doc);
        Assert.Equal([ErrorCode.ERR_INVALID_RELATIONSHIP], result.Errors.Select(e => e.Code));
        var match = result.Root.FindObject("Match")!;
        Assert.Null(RelationshipReferences.ResolveRelationshipReference(match, "valid", "Team"));
    }
}
