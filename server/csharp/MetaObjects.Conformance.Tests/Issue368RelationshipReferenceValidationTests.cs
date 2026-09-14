// Issue #368 — loader validation for relationship.* M:N slim vocabulary + the
// 1:N reference-disambiguation rules (the resolution ladder in
// MetaObjects.Core.Relationship.RelationshipReferences).
//
// C# port of the TS reference suite (relationship-m2m.test.ts) and its Python
// port (test_relationship_m2m_validation.py), covering the #368 additions:
//
//   (B) @sourceRefField becomes legal on @cardinality: "one" (previously
//       rejected on any non-M:N relationship).
//   (C) Rule (e) -- a @cardinality: one relationship must resolve to exactly
//       one identity.reference candidate; ambiguity is a load error.
//   (D) Both rule (d) (the M:N slim-vocabulary pass) and rule (e) iterate the
//       EFFECTIVE relationship set (own + inherited via extends), not just
//       own-declared relationships -- with rule (d) deduping on the
//       relationship node's identity (an inherited, unmodified relationship
//       must not be reported once per inheriting entity).
//
// Also regression-covers two latent "obj vs. declaring entity" bugs the TS/
// Python authors flagged when they switched rule (d) to resolving iteration
// (see d49c3d921 / 7fab449a2 commit messages) -- neither had a fixture in
// either port, so they are new here: ADR-0042 package resolution for a bare
// @through must use the DECLARING entity's package, and rule (a)'s self-join
// comparison must use the DECLARING entity, not whichever entity's effective
// view reached the inherited relationship first.
//
// See server/typescript/packages/metadata/src/core/relationship/
// resolve-relationship-reference.ts and .../src/loader/validation-passes.ts
// (validateRelationships / validateOneSideReferenceResolution) for the
// authoritative spec these tests mirror.

using MetaObjects.Loader;
using Xunit;

namespace MetaObjects.Conformance.Tests;

public class Issue368RelationshipReferenceValidationTests
{
    private static LoadResult LoadInline(string json) =>
        new MetaDataLoader().Load([new InMemoryStringSource(json, id: "inline.json")]);

    private static LoadResult LoadInlineMulti(params string[] jsons) =>
        new MetaDataLoader().Load(
            jsons.Select((json, i) => new InMemoryStringSource(json, id: $"inline-{i}.json"))
                .Cast<IMetaDataSource>()
                .ToArray());

    // -------------------------------------------------------------------------
    // (B) @sourceRefField becomes legal on @cardinality: "one"
    // -------------------------------------------------------------------------

    [Fact]
    public void Source_ref_field_on_cardinality_one_loads_clean()
    {
        // The issue #368 repro: two 1:N relationships, each disambiguated by
        // @sourceRefField, load with no errors.
        const string doc = """
        { "metadata.root": { "package": "repro", "children": [
          { "object.entity": { "name": "Team", "children": [
            { "field.long": { "name": "id" } },
            { "identity.primary": { "name": "id", "@fields": "id" } }
          ]}},
          { "object.entity": { "name": "Match", "children": [
            { "field.long": { "name": "id" } },
            { "field.long": { "name": "homeTeamId" } },
            { "field.long": { "name": "awayTeamId" } },
            { "identity.primary": { "name": "id", "@fields": "id" } },
            { "identity.reference": { "name": "homeTeamRef", "@fields": ["homeTeamId"], "@references": "Team" } },
            { "identity.reference": { "name": "awayTeamRef", "@fields": ["awayTeamId"], "@references": "Team" } },
            { "relationship.association": { "name": "homeTeam", "@objectRef": "Team", "@cardinality": "one", "@sourceRefField": "homeTeamId" } },
            { "relationship.association": { "name": "awayTeam", "@objectRef": "Team", "@cardinality": "one", "@sourceRefField": "awayTeamId" } }
          ]}}
        ]}}
        """;
        Assert.Empty(LoadInline(doc).Errors);
    }

    [Fact]
    public void Source_ref_field_on_many_without_through_still_errors()
    {
        // @sourceRefField on @cardinality: many with no @through is still not
        // M:N -- the widening only spares @cardinality: one.
        const string doc = """
        { "metadata.root": { "package": "repro", "children": [
          { "object.entity": { "name": "Team", "children": [
            { "field.long": { "name": "id" } },
            { "identity.primary": { "name": "id", "@fields": "id" } }
          ]}},
          { "object.entity": { "name": "Match", "children": [
            { "field.long": { "name": "id" } },
            { "identity.primary": { "name": "id", "@fields": "id" } },
            { "relationship.association": { "name": "teams", "@objectRef": "Team", "@cardinality": "many", "@sourceRefField": "whatever" } }
          ]}}
        ]}}
        """;
        Assert.Contains(LoadInline(doc).Errors, e => e.Code == ErrorCode.ERR_INVALID_RELATIONSHIP);
    }

    [Fact]
    public void Through_on_cardinality_one_still_errors()
    {
        // @through still requires @cardinality: many -- only @sourceRefField was widened.
        const string doc = """
        { "metadata.root": { "package": "acme", "children": [
          { "object.entity": { "name": "Week", "children": [
            { "field.long": { "name": "id" } },
            { "identity.primary": { "name": "id", "@fields": "id" } },
            { "relationship.composition": { "name": "program", "@objectRef": "Program", "@cardinality": "one", "@through": "X" } }
          ]}},
          { "object.entity": { "name": "Program", "children": [
            { "field.long": { "name": "id" } },
            { "identity.primary": { "name": "id", "@fields": "id" } }
          ]}}
        ]}}
        """;
        Assert.Contains(LoadInline(doc).Errors, e => e.Code == ErrorCode.ERR_INVALID_RELATIONSHIP);
    }

    [Fact]
    public void Symmetric_on_cardinality_one_still_errors()
    {
        // @symmetric still requires M:N -- only @sourceRefField was widened.
        const string doc = """
        { "metadata.root": { "package": "acme", "children": [
          { "object.entity": { "name": "Week", "children": [
            { "field.long": { "name": "id" } },
            { "identity.primary": { "name": "id", "@fields": "id" } },
            { "relationship.association": { "name": "program", "@objectRef": "Program", "@symmetric": true } }
          ]}},
          { "object.entity": { "name": "Program", "children": [
            { "field.long": { "name": "id" } },
            { "identity.primary": { "name": "id", "@fields": "id" } }
          ]}}
        ]}}
        """;
        Assert.Contains(LoadInline(doc).Errors, e => e.Code == ErrorCode.ERR_INVALID_RELATIONSHIP);
    }

    // -------------------------------------------------------------------------
    // (A) The resolution ladder, exercised end-to-end through the loader.
    // -------------------------------------------------------------------------

    [Fact]
    public void Issue_repro_loads_clean_via_name_pairing()
    {
        // Two references onto the same target, no @sourceRefField -- resolved by
        // name-pairing (homeTeamRef <-> homeTeam, awayTeamRef <-> awayTeam).
        const string doc = """
        { "metadata.root": { "package": "repro", "children": [
          { "object.entity": { "name": "Team", "children": [
            { "field.long": { "name": "id" } },
            { "identity.primary": { "name": "id", "@fields": "id" } }
          ]}},
          { "object.entity": { "name": "Match", "children": [
            { "field.long": { "name": "id" } },
            { "field.long": { "name": "homeTeamId" } },
            { "field.long": { "name": "awayTeamId" } },
            { "identity.primary": { "name": "id", "@fields": "id" } },
            { "identity.reference": { "name": "homeTeamRef", "@fields": ["homeTeamId"], "@references": "Team" } },
            { "relationship.association": { "name": "homeTeam", "@objectRef": "Team", "@cardinality": "one" } },
            { "identity.reference": { "name": "awayTeamRef", "@fields": ["awayTeamId"], "@references": "Team" } },
            { "relationship.association": { "name": "awayTeam", "@objectRef": "Team", "@cardinality": "one" } }
          ]}}
        ]}}
        """;
        Assert.Empty(LoadInline(doc).Errors);
    }

    [Fact]
    public void Unpairable_names_error_naming_both_candidates()
    {
        // Two references whose names don't pair with the relationship name --
        // ambiguous, and the error names both candidates as name(fkField).
        const string doc = """
        { "metadata.root": { "package": "repro", "children": [
          { "object.entity": { "name": "Team", "children": [
            { "field.long": { "name": "id" } },
            { "identity.primary": { "name": "id", "@fields": "id" } }
          ]}},
          { "object.entity": { "name": "Match", "children": [
            { "field.long": { "name": "id" } },
            { "field.long": { "name": "alphaFk" } },
            { "field.long": { "name": "betaFk" } },
            { "identity.primary": { "name": "id", "@fields": "id" } },
            { "identity.reference": { "name": "alphaRef", "@fields": ["alphaFk"], "@references": "Team" } },
            { "identity.reference": { "name": "betaRef", "@fields": ["betaFk"], "@references": "Team" } },
            { "relationship.association": { "name": "winner", "@objectRef": "Team", "@cardinality": "one" } }
          ]}}
        ]}}
        """;
        var result = LoadInline(doc);
        Assert.Contains(result.Errors, e => e.Code == ErrorCode.ERR_INVALID_RELATIONSHIP);
        string joined = string.Join("\n", result.Errors.Select(e => e.Message));
        Assert.Contains("Match.winner", joined);
        Assert.Contains("alphaRef(alphaFk)", joined);
        Assert.Contains("betaRef(betaFk)", joined);
    }

    [Fact]
    public void Declared_but_unmatched_errors_at_single_candidate_count()
    {
        // A declared @sourceRefField naming nothing must error even with exactly
        // one candidate -- the ladder's step 1 ("exactly one candidate -> that
        // one") must not silently short-circuit past a bad declared value.
        const string doc = """
        { "metadata.root": { "package": "repro", "children": [
          { "object.entity": { "name": "Team", "children": [
            { "field.long": { "name": "id" } },
            { "identity.primary": { "name": "id", "@fields": "id" } }
          ]}},
          { "object.entity": { "name": "Match", "children": [
            { "field.long": { "name": "id" } },
            { "field.long": { "name": "homeTeamId" } },
            { "identity.primary": { "name": "id", "@fields": "id" } },
            { "identity.reference": { "name": "homeTeamRef", "@fields": ["homeTeamId"], "@references": "Team" } },
            { "relationship.association": { "name": "awayTeam", "@objectRef": "Team", "@cardinality": "one", "@sourceRefField": "awayTeamId" } }
          ]}}
        ]}}
        """;
        var result = LoadInline(doc);
        Assert.Equal([ErrorCode.ERR_INVALID_RELATIONSHIP], result.Errors.Select(e => e.Code));
        string joined = string.Join("\n", result.Errors.Select(e => e.Message));
        Assert.Contains("Match.awayTeam", joined);
        Assert.Contains("\"awayTeamId\"", joined);
    }

    [Fact]
    public void Declared_but_unmatched_errors_at_zero_candidate_count()
    {
        // A declared @sourceRefField naming nothing must also error with ZERO
        // candidates (no identity.reference targets the objectRef at all) -- the
        // declared value is read BEFORE any candidate-count guard.
        const string doc = """
        { "metadata.root": { "package": "repro", "children": [
          { "object.entity": { "name": "Team", "children": [
            { "field.long": { "name": "id" } },
            { "identity.primary": { "name": "id", "@fields": "id" } }
          ]}},
          { "object.entity": { "name": "Match", "children": [
            { "field.long": { "name": "id" } },
            { "identity.primary": { "name": "id", "@fields": "id" } },
            { "relationship.association": { "name": "homeTeam", "@objectRef": "Team", "@cardinality": "one", "@sourceRefField": "homeTeamId" } }
          ]}}
        ]}}
        """;
        var result = LoadInline(doc);
        Assert.Equal([ErrorCode.ERR_INVALID_RELATIONSHIP], result.Errors.Select(e => e.Code));
        string joined = string.Join("\n", result.Errors.Select(e => e.Message));
        Assert.Contains("Match.homeTeam", joined);
        Assert.Contains("\"homeTeamId\"", joined);
    }

    [Fact]
    public void Source_ref_field_correctly_naming_single_candidate_loads_clean()
    {
        // Regression: a correctly-declared @sourceRefField over a single
        // candidate stays clean.
        const string doc = """
        { "metadata.root": { "package": "repro", "children": [
          { "object.entity": { "name": "Team", "children": [
            { "field.long": { "name": "id" } },
            { "identity.primary": { "name": "id", "@fields": "id" } }
          ]}},
          { "object.entity": { "name": "Match", "children": [
            { "field.long": { "name": "id" } },
            { "field.long": { "name": "homeTeamId" } },
            { "identity.primary": { "name": "id", "@fields": "id" } },
            { "identity.reference": { "name": "homeTeamRef", "@fields": ["homeTeamId"], "@references": "Team" } },
            { "relationship.association": { "name": "homeTeam", "@objectRef": "Team", "@cardinality": "one", "@sourceRefField": "homeTeamId" } }
          ]}}
        ]}}
        """;
        Assert.Empty(LoadInline(doc).Errors);
    }

    [Fact]
    public void Composite_reference_candidates_render_full_field_tuple()
    {
        // Two composite references sharing a first column must still print
        // distinguishably in the candidate list (fields[0] alone would collide).
        const string doc = """
        { "metadata.root": { "package": "repro", "children": [
          { "object.entity": { "name": "Team", "children": [
            { "field.long": { "name": "id" } },
            { "identity.primary": { "name": "id", "@fields": "id" } }
          ]}},
          { "object.entity": { "name": "Match", "children": [
            { "field.long": { "name": "id" } },
            { "field.long": { "name": "tenantId" } },
            { "field.long": { "name": "homeTeamId" } },
            { "field.long": { "name": "awayTeamId" } },
            { "identity.primary": { "name": "id", "@fields": "id" } },
            { "identity.reference": { "name": "aRef", "@fields": ["tenantId", "homeTeamId"], "@references": "Team" } },
            { "identity.reference": { "name": "bRef", "@fields": ["tenantId", "awayTeamId"], "@references": "Team" } },
            { "relationship.association": { "name": "winner", "@objectRef": "Team", "@cardinality": "one" } }
          ]}}
        ]}}
        """;
        var result = LoadInline(doc);
        Assert.Contains(result.Errors, e => e.Code == ErrorCode.ERR_INVALID_RELATIONSHIP);
        string joined = string.Join("\n", result.Errors.Select(e => e.Message));
        Assert.Contains("aRef(tenantId, homeTeamId)", joined);
        Assert.Contains("bRef(tenantId, awayTeamId)", joined);
    }

    // -------------------------------------------------------------------------
    // Cross-relationship state-leakage regression: a declared-but-unmatched
    // @sourceRefField at 2+ candidates on one relationship must not affect a
    // SIBLING relationship on the same entity whose declared field DOES match.
    // Backfilled from the Java port (Issue368RelationshipReferenceValidationTest
    // .siblingRelationshipWithMatchingSourceRefFieldProducesNoErrorWhileTheBadOneDoes) --
    // the case most likely to catch per-relationship state accidentally shared
    // across a loop iteration.
    // -------------------------------------------------------------------------

    [Fact]
    public void Sibling_relationship_with_matching_source_ref_field_produces_no_error_while_the_bad_one_does()
    {
        const string doc = """
        { "metadata.root": { "package": "repro", "children": [
          { "object.entity": { "name": "Team", "children": [
            { "field.long": { "name": "id" } },
            { "identity.primary": { "name": "id", "@fields": "id" } }
          ]}},
          { "object.entity": { "name": "Venue", "children": [
            { "field.long": { "name": "id" } },
            { "identity.primary": { "name": "id", "@fields": "id" } }
          ]}},
          { "object.entity": { "name": "Match", "children": [
            { "field.long": { "name": "id" } },
            { "field.long": { "name": "venueId" } },
            { "field.long": { "name": "alphaFk" } },
            { "field.long": { "name": "betaFk" } },
            { "identity.primary": { "name": "id", "@fields": "id" } },
            { "identity.reference": { "name": "venueRef", "@fields": ["venueId"], "@references": "Venue" } },
            { "relationship.association": { "name": "venue", "@objectRef": "Venue", "@cardinality": "one", "@sourceRefField": "venueId" } },
            { "identity.reference": { "name": "alphaRef", "@fields": ["alphaFk"], "@references": "Team" } },
            { "identity.reference": { "name": "betaRef", "@fields": ["betaFk"], "@references": "Team" } },
            { "relationship.association": { "name": "winner", "@objectRef": "Team", "@cardinality": "one", "@sourceRefField": "doesNotExist" } }
          ]}}
        ]}}
        """;
        var result = LoadInline(doc);
        Assert.Equal([ErrorCode.ERR_INVALID_RELATIONSHIP], result.Errors.Select(e => e.Code));
        string joined = string.Join("\n", result.Errors.Select(e => e.Message));
        Assert.Contains("Match.winner", joined);
        Assert.Contains("\"doesNotExist\"", joined);
        // The good sibling must never be named in any error -- no state leaked
        // from evaluating "winner" into (or out of) evaluating "venue".
        Assert.DoesNotContain("Match.venue", joined);
    }

    // -------------------------------------------------------------------------
    // (D) Rule (e) must iterate the EFFECTIVE relationship set.
    // -------------------------------------------------------------------------

    [Fact]
    public void Inherited_relationship_ambiguity_errors()
    {
        // A extends cleanly; B extends A and adds a second reference onto the
        // same target -- the inherited relationship becomes ambiguous on B even
        // though A (and the relationship's own declaration) are untouched.
        const string doc = """
        { "metadata.root": { "package": "repro", "children": [
          { "object.entity": { "name": "Team", "children": [
            { "field.long": { "name": "id" } },
            { "identity.primary": { "name": "id", "@fields": "id" } }
          ]}},
          { "object.entity": { "name": "A", "children": [
            { "field.long": { "name": "id" } },
            { "field.long": { "name": "homeTeamId" } },
            { "identity.primary": { "name": "id", "@fields": "id" } },
            { "identity.reference": { "name": "homeTeamRef", "@fields": ["homeTeamId"], "@references": "Team" } },
            { "relationship.association": { "name": "winner", "@objectRef": "Team", "@cardinality": "one" } }
          ]}},
          { "object.entity": { "name": "B", "extends": "A", "children": [
            { "field.long": { "name": "awayTeamId" } },
            { "identity.reference": { "name": "awayTeamRef", "@fields": ["awayTeamId"], "@references": "Team" } }
          ]}}
        ]}}
        """;
        var result = LoadInline(doc);
        Assert.Equal([ErrorCode.ERR_INVALID_RELATIONSHIP], result.Errors.Select(e => e.Code));
        string joined = string.Join("\n", result.Errors.Select(e => e.Message));
        Assert.Contains("B.winner", joined);
        Assert.Contains("homeTeamRef(homeTeamId)", joined);
        Assert.Contains("awayTeamRef(awayTeamId)", joined);
    }

    [Fact]
    public void Inherited_relationship_resolved_by_child_added_reference_loads_clean()
    {
        // A child entity's added reference that name-pairs with the inherited
        // relationship resolves cleanly.
        const string doc = """
        { "metadata.root": { "package": "repro", "children": [
          { "object.entity": { "name": "Team", "children": [
            { "field.long": { "name": "id" } },
            { "identity.primary": { "name": "id", "@fields": "id" } }
          ]}},
          { "object.entity": { "name": "A", "children": [
            { "field.long": { "name": "id" } },
            { "field.long": { "name": "homeTeamId" } },
            { "identity.primary": { "name": "id", "@fields": "id" } },
            { "identity.reference": { "name": "homeTeamRef", "@fields": ["homeTeamId"], "@references": "Team" } },
            { "relationship.association": { "name": "awayTeam", "@objectRef": "Team", "@cardinality": "one" } }
          ]}},
          { "object.entity": { "name": "B", "extends": "A", "children": [
            { "field.long": { "name": "awayTeamId" } },
            { "identity.reference": { "name": "awayTeamRef", "@fields": ["awayTeamId"], "@references": "Team" } }
          ]}}
        ]}}
        """;
        Assert.Empty(LoadInline(doc).Errors);
    }

    // -------------------------------------------------------------------------
    // (D) Rule (d) dedupe -- own attrs never change per inheriting entity, so an
    // inherited unmodified relationship must be reported exactly once.
    // -------------------------------------------------------------------------

    [Fact]
    public void Rule_d_dedupe_single_error_for_one_inheriting_child()
    {
        const string doc = """
        { "metadata.root": { "package": "repro", "children": [
          { "object.entity": { "name": "Program", "children": [
            { "field.long": { "name": "id" } },
            { "identity.primary": { "name": "id", "@fields": "id" } }
          ]}},
          { "object.entity": { "name": "A", "children": [
            { "field.long": { "name": "id" } },
            { "relationship.composition": { "name": "program", "@objectRef": "Program", "@cardinality": "one", "@through": "X" } },
            { "identity.primary": { "name": "id", "@fields": "id" } }
          ]}},
          { "object.entity": { "name": "B", "extends": "A" } }
        ]}}
        """;
        Assert.Equal([ErrorCode.ERR_INVALID_RELATIONSHIP], LoadInline(doc).Errors.Select(e => e.Code));
    }

    [Fact]
    public void Rule_d_dedupe_single_error_across_several_inheriting_children()
    {
        const string doc = """
        { "metadata.root": { "package": "repro", "children": [
          { "object.entity": { "name": "Program", "children": [
            { "field.long": { "name": "id" } },
            { "identity.primary": { "name": "id", "@fields": "id" } }
          ]}},
          { "object.entity": { "name": "A", "children": [
            { "field.long": { "name": "id" } },
            { "relationship.composition": { "name": "program", "@objectRef": "Program", "@cardinality": "one", "@through": "X" } },
            { "identity.primary": { "name": "id", "@fields": "id" } }
          ]}},
          { "object.entity": { "name": "B", "extends": "A" } },
          { "object.entity": { "name": "C", "extends": "A" } },
          { "object.entity": { "name": "D", "extends": "A" } }
        ]}}
        """;
        Assert.Equal([ErrorCode.ERR_INVALID_RELATIONSHIP], LoadInline(doc).Errors.Select(e => e.Code));
    }

    // -------------------------------------------------------------------------
    // Two latent "obj vs. declaring entity" bugs the TS/Python authors flagged
    // (but did not cover with a fixture) when rule (d) switched to resolving
    // iteration -- see d49c3d921 / 7fab449a2. Regression-covered here.
    // -------------------------------------------------------------------------

    [Fact]
    public void Inherited_self_join_relationship_is_not_misflagged_as_non_self_join()
    {
        // Node extends NodeBase, which declares a @symmetric self-join
        // relationship onto NodeBase itself (@objectRef: "NodeBase"). Node is
        // declared BEFORE NodeBase (extends is resolved order-independently by
        // a deferred pass, so this is legal) so that the outer validation loop
        // visits `obj = Node` FIRST -- if rule (a)'s self-join comparison used
        // the visiting `obj` instead of the relationship's DECLARING entity
        // (NodeBase, via rel.Parent), it would wrongly conclude @objectRef
        // "NodeBase" is not the (visiting) declaring entity "Node" and misfire
        // ERR_BAD_ATTR_VALUE -- and dedupe would then lock in that wrong result
        // when NodeBase's own turn came second.
        const string doc = """
        { "metadata.root": { "package": "acme", "children": [
          { "object.entity": { "name": "Node", "extends": "NodeBase", "children": [
            { "field.long": { "name": "id" } },
            { "identity.primary": { "name": "id", "@fields": "id" } }
          ]}},
          { "object.entity": { "name": "NodeBase", "@isAbstract": true, "children": [
            { "relationship.association": { "name": "peers", "@cardinality": "many", "@objectRef": "NodeBase",
                "@through": "NodeLink", "@symmetric": true } }
          ]}},
          { "object.entity": { "name": "NodeLink", "children": [
            { "field.long": { "name": "id" } },
            { "field.long": { "name": "aId" } },
            { "field.long": { "name": "bId" } },
            { "identity.primary": { "name": "id", "@fields": "id" } },
            { "identity.reference": { "name": "a", "@fields": ["aId"], "@references": "NodeBase" } },
            { "identity.reference": { "name": "b", "@fields": ["bId"], "@references": "NodeBase" } }
          ]}}
        ]}}
        """;
        var result = LoadInline(doc);
        Assert.DoesNotContain(result.Errors, e => e.Code == ErrorCode.ERR_BAD_ATTR_VALUE);
        Assert.DoesNotContain(result.Errors, e => e.Code == ErrorCode.ERR_INVALID_RELATIONSHIP);
    }

    [Fact]
    public void Inherited_bare_through_resolves_in_the_declaring_entity_package_not_the_visiting_one()
    {
        // WeekBase (package "base") declares a M:N relationship with a BARE
        // @through "Tag" -- ADR-0042 says a bare ref resolves in the DECLARING
        // entity's package ("base::Tag"), never the package of whichever entity
        // inherits and visits it. Week extends WeekBase from a DIFFERENT package
        // ("acme") that also happens to declare its own unrelated "Tag" entity.
        // The acme source is loaded FIRST so the outer validation loop visits
        // `obj = Week` before `obj = WeekBase` -- if @through resolution used
        // the visiting entity's package it would wrongly bind to "acme::Tag"
        // (which has zero identity.reference children) instead of "base::Tag"
        // (which correctly has two), and dedupe would lock in that wrong result
        // before WeekBase's own (correct) turn ever came.
        const string baseDoc = """
        { "metadata.root": { "package": "base", "children": [
          { "object.entity": { "name": "WeekBase", "@isAbstract": true, "children": [
            { "relationship.association": { "name": "tags", "@cardinality": "many", "@objectRef": "Tag", "@through": "Tag" } }
          ]}},
          { "object.entity": { "name": "Tag", "children": [
            { "field.long": { "name": "id" } },
            { "field.long": { "name": "weekId" } },
            { "field.long": { "name": "labelId" } },
            { "identity.primary": { "name": "id", "@fields": "id" } },
            { "identity.reference": { "name": "w", "@fields": ["weekId"], "@references": "base::WeekBase" } },
            { "identity.reference": { "name": "l", "@fields": ["labelId"], "@references": "base::Tag" } }
          ]}}
        ]}}
        """;
        const string acmeDoc = """
        { "metadata.root": { "package": "acme", "children": [
          { "object.entity": { "name": "Week", "extends": "base::WeekBase", "children": [
            { "field.long": { "name": "id" } },
            { "identity.primary": { "name": "id", "@fields": "id" } }
          ]}},
          { "object.entity": { "name": "Tag", "children": [
            { "field.long": { "name": "id" } },
            { "identity.primary": { "name": "id", "@fields": "id" } }
          ]}}
        ]}}
        """;
        var result = LoadInlineMulti(acmeDoc, baseDoc);
        Assert.DoesNotContain(result.Errors, e => e.Code == ErrorCode.ERR_INVALID_RELATIONSHIP);
    }

    // -------------------------------------------------------------------------
    // Regression: valid M:N still loads clean.
    // -------------------------------------------------------------------------

    [Fact]
    public void Valid_hetero_m2m_produces_no_relationship_errors()
    {
        const string doc = """
        { "metadata.root": { "package": "acme", "children": [
          { "object.entity": { "name": "Post", "children": [
            { "field.long": { "name": "id" } },
            { "relationship.association": { "name": "tags", "@cardinality": "many", "@objectRef": "Tag", "@through": "PostTag" } },
            { "identity.primary": { "name": "id", "@fields": "id" } }
          ]}},
          { "object.entity": { "name": "Tag", "children": [
            { "field.long": { "name": "id" } },
            { "identity.primary": { "name": "id", "@fields": "id" } }
          ]}},
          { "object.entity": { "name": "PostTag", "children": [
            { "field.long": { "name": "id" } },
            { "field.long": { "name": "postId" } },
            { "field.long": { "name": "tagId" } },
            { "identity.primary": { "name": "id", "@fields": "id" } },
            { "identity.reference": { "name": "p", "@fields": ["postId"], "@references": "Post" } },
            { "identity.reference": { "name": "t", "@fields": ["tagId"], "@references": "Tag" } }
          ]}}
        ]}}
        """;
        var result = LoadInline(doc);
        Assert.DoesNotContain(result.Errors, e => e.Code == ErrorCode.ERR_INVALID_RELATIONSHIP);
        Assert.DoesNotContain(result.Errors, e => e.Code == ErrorCode.ERR_BAD_ATTR_VALUE);
    }
}
