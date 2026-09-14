// Issue #368 round 2 — the same "matches on target alone" defect the ladder
// (MetaObjects.Core.Relationship.RelationshipReferences) fixed for relationship
// navigation also existed in MetaObjects.Persistence.Db.ReferentialActions:
// correlating an identity.reference to the relationship.* that supplies its
// @onDelete / @onUpdate matched on the TARGET ENTITY ALONE, so when an entity
// declares more than one relationship to the same target (Match.homeTeam /
// awayTeam, both -> Team), every FK past the first silently inherited the
// FIRST relationship's referential actions.
//
// C# port of the TS suite
// (server/typescript/packages/migrate-ts/test/unit/referential-actions.test.ts,
// describe("#368 round 2: ...")) — that file is the authoritative spec; this
// mirrors it directly against ReferentialActions.Resolve.

using MetaObjects.Loader;
using MetaObjects.Meta;
using MetaObjects.Persistence.Db;
using Xunit;

namespace MetaObjects.Conformance.Tests;

public class Issue368ReferentialActionsTests
{
    private static LoadResult LoadInline(string json) =>
        new MetaDataLoader().Load([new InMemoryStringSource(json, id: "inline.json")]);

    // Not an interpolated raw string: the model is dense in `}}`, which an
    // interpolated raw string would read as an interpolation hole (see the
    // comment on TwoEntityTemplate in Issue294ReferentialActionTests.cs).
    private const string MatchTeamTemplate = """
    { "metadata.root": { "package": "acme", "children": [
      { "object.entity": { "name": "Team", "children": [
        { "field.long": { "name": "id" } },
        { "identity.primary": { "name": "id", "@fields": "id" } }
      ]}},
      { "object.entity": { "name": "Match", "children": [
        { "field.long": { "name": "id" } },
        { "field.long": { "name": "homeTeamId" } },
        { "field.long": { "name": "awayTeamId" } },
        { "identity.reference": { "name": "homeTeamRef", "@fields": ["homeTeamId"], "@references": "Team" } },
        { "identity.reference": { "name": "awayTeamRef", "@fields": ["awayTeamId"], "@references": "Team" } },
        /*RELS*/,
        { "identity.primary": { "name": "id", "@fields": "id" } }
      ]}}
    ]}}
    """;

    private static string MatchTeamDoc(string rels) => MatchTeamTemplate.Replace("/*RELS*/", rels);

    private static (MetaObject Match, MetaReferenceIdentity HomeTeamRef, MetaReferenceIdentity AwayTeamRef)
        LoadMatchTeam(string rels)
    {
        var result = LoadInline(MatchTeamDoc(rels));
        Assert.Empty(result.Errors);
        var match = result.Root.FindObject("Match")!;
        var homeTeamRef = match.ReferenceIdentities().Single(r => r.Name == "homeTeamRef");
        var awayTeamRef = match.ReferenceIdentities().Single(r => r.Name == "awayTeamRef");
        return (match, homeTeamRef, awayTeamRef);
    }

    [Fact]
    public void REGRESSION_name_pairing_each_FK_gets_its_own_relationships_action()
    {
        var (match, homeTeamRef, awayTeamRef) = LoadMatchTeam("""
            { "relationship.association": { "name": "homeTeam", "@objectRef": "Team", "@cardinality": "one", "@onDelete": "restrict" } },
            { "relationship.composition": { "name": "awayTeam", "@objectRef": "Team", "@cardinality": "one", "@onDelete": "cascade" } }
            """);
        Assert.Equal(new ResolvedReferentialActions("restrict", "cascade"), ReferentialActions.Resolve(match, homeTeamRef));
        Assert.Equal(new ResolvedReferentialActions("cascade", "cascade"), ReferentialActions.Resolve(match, awayTeamRef));
    }

    [Fact]
    public void REGRESSION_source_ref_field_each_FK_gets_its_own_relationships_action_even_when_names_dont_pair()
    {
        // Relationship names deliberately don't name-pair with either reference —
        // only @sourceRefField can route these correctly.
        var (match, homeTeamRef, awayTeamRef) = LoadMatchTeam("""
            { "relationship.association": { "name": "primary", "@objectRef": "Team", "@cardinality": "one", "@onDelete": "restrict", "@sourceRefField": "homeTeamId" } },
            { "relationship.composition": { "name": "secondary", "@objectRef": "Team", "@cardinality": "one", "@onDelete": "cascade", "@sourceRefField": "awayTeamId" } }
            """);
        Assert.Equal(new ResolvedReferentialActions("restrict", "cascade"), ReferentialActions.Resolve(match, homeTeamRef));
        Assert.Equal(new ResolvedReferentialActions("cascade", "cascade"), ReferentialActions.Resolve(match, awayTeamRef));
    }

    [Fact]
    public void No_regression_a_single_relationship_to_a_target_still_resolves_regardless_of_its_name()
    {
        // Only one reference to Team exists here (winnerRef) — the relationship
        // name "champion" pairs with neither reference's name, but the ladder's
        // "exactly one candidate" tier means naming never mattered for this, by
        // far the most common, shape.
        const string doc = """
        { "metadata.root": { "package": "acme", "children": [
          { "object.entity": { "name": "Team", "children": [
            { "field.long": { "name": "id" } },
            { "identity.primary": { "name": "id", "@fields": "id" } }
          ]}},
          { "object.entity": { "name": "Match", "children": [
            { "field.long": { "name": "id" } },
            { "field.long": { "name": "winnerId" } },
            { "identity.reference": { "name": "winnerRef", "@fields": ["winnerId"], "@references": "Team" } },
            { "relationship.composition": { "name": "champion", "@objectRef": "Team", "@cardinality": "one" } },
            { "identity.primary": { "name": "id", "@fields": "id" } }
          ]}}
        ]}}
        """;
        var result = LoadInline(doc);
        Assert.Empty(result.Errors);
        var match = result.Root.FindObject("Match")!;
        var reference = match.ReferenceIdentities().Single();
        Assert.Equal(new ResolvedReferentialActions("cascade", "cascade"), ReferentialActions.Resolve(match, reference));
    }

    [Fact]
    public void Unresolvable_correlation_emits_the_default_not_the_first_relationships_action()
    {
        // Neither relationship name pairs with either reference and no
        // @sourceRefField disambiguates — the ladder can't choose. This is the
        // SAME ambiguity rule (e) already refuses at load time (ADR-0029 §5),
        // mirroring how Issue368RelationshipReferenceLadderTests asserts the
        // load error directly rather than requiring a clean load. Resolve()
        // still fails closed (no action on either FK) as defense in depth,
        // rather than either one inheriting the first relationship's action.
        var result = LoadInline(MatchTeamDoc("""
            { "relationship.association": { "name": "primary", "@objectRef": "Team", "@cardinality": "one", "@onDelete": "restrict" } },
            { "relationship.composition": { "name": "secondary", "@objectRef": "Team", "@cardinality": "one", "@onDelete": "cascade" } }
            """));
        Assert.Equal(
            [ErrorCode.ERR_INVALID_RELATIONSHIP, ErrorCode.ERR_INVALID_RELATIONSHIP],
            result.Errors.Select(e => e.Code));
        var match = result.Root.FindObject("Match")!;
        var homeTeamRef = match.ReferenceIdentities().Single(r => r.Name == "homeTeamRef");
        var awayTeamRef = match.ReferenceIdentities().Single(r => r.Name == "awayTeamRef");
        Assert.Equal(new ResolvedReferentialActions(null, null), ReferentialActions.Resolve(match, homeTeamRef));
        Assert.Equal(new ResolvedReferentialActions(null, null), ReferentialActions.Resolve(match, awayTeamRef));
    }
}
