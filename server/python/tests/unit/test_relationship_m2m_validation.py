"""Loader validation for relationship.* M:N slim vocabulary + #368 1:N
reference-disambiguation rules.

Python port of the TS reference suite
(``metadata/test/relationship-m2m.test.ts``) covering the #368 additions:

  (B) ``@sourceRefField`` becomes legal on ``@cardinality: "one"`` (previously
      rejected on any non-M:N relationship).
  (C) Rule (e) -- a `@cardinality: one` relationship must resolve to exactly
      one identity.reference candidate; ambiguity is a load error.
  (D) Both rule (d) (the M:N slim-vocabulary pass) and rule (e) iterate the
      EFFECTIVE relationship set (own + inherited via extends), not just
      own-declared relationships -- with rule (d) deduping on the
      relationship node's identity (an inherited, unmodified relationship
      must not be reported once per inheriting entity).

See ``server/typescript/packages/metadata/src/core/relationship/
resolve-relationship-reference.ts`` and ``.../src/loader/validation-passes.ts``
(``validateRelationships`` / ``validateOneSideReferenceResolution``) for the
authoritative spec these tests mirror.
"""
from __future__ import annotations

import json

from metaobjects import InMemoryStringSource, MetaDataLoader
from metaobjects.shared.base_types import TYPE_OBJECT


def _load(doc: dict) -> tuple[list[str], list[str]]:
    """Load *doc* and return (error codes, error messages)."""
    result = MetaDataLoader().load([InMemoryStringSource(json.dumps(doc))])
    codes = [e.code.value for e in result.errors]
    messages = [e.message for e in result.errors]
    return codes, messages


def _load_multi(*docs: dict) -> tuple[list[str], list[str], list[str]]:
    """Load several docs as separate sources and return (error codes, error
    messages, object visit order) -- the visit order is the resolution key
    of each ``object.entity`` in ``root.children()`` iteration order, i.e.
    the same order ``validate_relationships``'s outer loop sees them in."""
    sources = [
        InMemoryStringSource(json.dumps(doc), id=f"inline-{i}.json")
        for i, doc in enumerate(docs)
    ]
    result = MetaDataLoader().load(sources)
    codes = [e.code.value for e in result.errors]
    messages = [e.message for e in result.errors]
    visit_order = [c.resolution_key() for c in result.root.children() if c.type == TYPE_OBJECT]
    return codes, messages, visit_order


# ---------------------------------------------------------------------------
# (B) @sourceRefField becomes legal on @cardinality: "one"
# ---------------------------------------------------------------------------


def test_source_ref_field_on_cardinality_one_loads_clean() -> None:
    """The issue #368 repro: two 1:N relationships, each disambiguated by
    @sourceRefField, load with no errors."""
    doc = {"metadata.root": {"package": "repro", "children": [
        {"object.entity": {"name": "Team", "children": [
            {"field.long": {"name": "id"}},
            {"identity.primary": {"name": "id", "@fields": "id"}},
        ]}},
        {"object.entity": {"name": "Match", "children": [
            {"field.long": {"name": "id"}},
            {"field.long": {"name": "homeTeamId"}},
            {"field.long": {"name": "awayTeamId"}},
            {"identity.primary": {"name": "id", "@fields": "id"}},
            {"identity.reference": {"name": "homeTeamRef", "@fields": ["homeTeamId"], "@references": "Team"}},
            {"identity.reference": {"name": "awayTeamRef", "@fields": ["awayTeamId"], "@references": "Team"}},
            {"relationship.association": {"name": "homeTeam", "@objectRef": "Team", "@cardinality": "one", "@sourceRefField": "homeTeamId"}},
            {"relationship.association": {"name": "awayTeam", "@objectRef": "Team", "@cardinality": "one", "@sourceRefField": "awayTeamId"}},
        ]}},
    ]}}
    codes, _ = _load(doc)
    assert codes == []


def test_source_ref_field_on_many_without_through_still_errors() -> None:
    """@sourceRefField on @cardinality: many with no @through is still not
    M:N -- the widening only spares @cardinality: one."""
    doc = {"metadata.root": {"package": "repro", "children": [
        {"object.entity": {"name": "Team", "children": [
            {"field.long": {"name": "id"}},
            {"identity.primary": {"name": "id", "@fields": "id"}},
        ]}},
        {"object.entity": {"name": "Match", "children": [
            {"field.long": {"name": "id"}},
            {"identity.primary": {"name": "id", "@fields": "id"}},
            {"relationship.association": {"name": "teams", "@objectRef": "Team", "@cardinality": "many", "@sourceRefField": "whatever"}},
        ]}},
    ]}}
    codes, _ = _load(doc)
    assert "ERR_INVALID_RELATIONSHIP" in codes


def test_through_on_cardinality_one_still_errors() -> None:
    """@through still requires @cardinality: many -- only @sourceRefField
    was widened."""
    doc = {"metadata.root": {"package": "acme", "children": [
        {"object.entity": {"name": "Week", "children": [
            {"field.long": {"name": "id"}},
            {"identity.primary": {"name": "id", "@fields": "id"}},
            {"relationship.composition": {"name": "program", "@objectRef": "Program", "@cardinality": "one", "@through": "X"}},
        ]}},
        {"object.entity": {"name": "Program", "children": [
            {"field.long": {"name": "id"}},
            {"identity.primary": {"name": "id", "@fields": "id"}},
        ]}},
    ]}}
    codes, _ = _load(doc)
    assert "ERR_INVALID_RELATIONSHIP" in codes


def test_symmetric_on_cardinality_one_still_errors() -> None:
    """@symmetric still requires M:N -- only @sourceRefField was widened."""
    doc = {"metadata.root": {"package": "acme", "children": [
        {"object.entity": {"name": "Week", "children": [
            {"field.long": {"name": "id"}},
            {"identity.primary": {"name": "id", "@fields": "id"}},
            {"relationship.association": {"name": "program", "@objectRef": "Program", "@symmetric": True}},
        ]}},
        {"object.entity": {"name": "Program", "children": [
            {"field.long": {"name": "id"}},
            {"identity.primary": {"name": "id", "@fields": "id"}},
        ]}},
    ]}}
    codes, _ = _load(doc)
    assert "ERR_INVALID_RELATIONSHIP" in codes


# ---------------------------------------------------------------------------
# (A) The resolution ladder, exercised end-to-end through the loader.
# ---------------------------------------------------------------------------


def test_issue_repro_loads_clean_via_name_pairing() -> None:
    """Two references onto the same target, no @sourceRefField -- resolved by
    name-pairing (homeTeamRef <-> homeTeam, awayTeamRef <-> awayTeam)."""
    doc = {"metadata.root": {"package": "repro", "children": [
        {"object.entity": {"name": "Team", "children": [
            {"field.long": {"name": "id"}},
            {"identity.primary": {"name": "id", "@fields": "id"}},
        ]}},
        {"object.entity": {"name": "Match", "children": [
            {"field.long": {"name": "id"}},
            {"field.long": {"name": "homeTeamId"}},
            {"field.long": {"name": "awayTeamId"}},
            {"identity.primary": {"name": "id", "@fields": "id"}},
            {"identity.reference": {"name": "homeTeamRef", "@fields": ["homeTeamId"], "@references": "Team"}},
            {"relationship.association": {"name": "homeTeam", "@objectRef": "Team", "@cardinality": "one"}},
            {"identity.reference": {"name": "awayTeamRef", "@fields": ["awayTeamId"], "@references": "Team"}},
            {"relationship.association": {"name": "awayTeam", "@objectRef": "Team", "@cardinality": "one"}},
        ]}},
    ]}}
    codes, _ = _load(doc)
    assert codes == []


def test_unpairable_names_error_naming_both_candidates() -> None:
    """Two references whose names don't pair with the relationship name --
    ambiguous, and the error names both candidates as name(fkField)."""
    doc = {"metadata.root": {"package": "repro", "children": [
        {"object.entity": {"name": "Team", "children": [
            {"field.long": {"name": "id"}},
            {"identity.primary": {"name": "id", "@fields": "id"}},
        ]}},
        {"object.entity": {"name": "Match", "children": [
            {"field.long": {"name": "id"}},
            {"field.long": {"name": "alphaFk"}},
            {"field.long": {"name": "betaFk"}},
            {"identity.primary": {"name": "id", "@fields": "id"}},
            {"identity.reference": {"name": "alphaRef", "@fields": ["alphaFk"], "@references": "Team"}},
            {"identity.reference": {"name": "betaRef", "@fields": ["betaFk"], "@references": "Team"}},
            {"relationship.association": {"name": "winner", "@objectRef": "Team", "@cardinality": "one"}},
        ]}},
    ]}}
    codes, messages = _load(doc)
    assert "ERR_INVALID_RELATIONSHIP" in codes
    joined = "\n".join(messages)
    assert "Match.winner" in joined
    assert "alphaRef(alphaFk)" in joined
    assert "betaRef(betaFk)" in joined


def test_declared_but_unmatched_errors_at_single_candidate_count() -> None:
    """A declared @sourceRefField naming nothing must error even with exactly
    one candidate -- the ladder's step 1 ("exactly one candidate -> that
    one") must not silently short-circuit past a bad declared value."""
    doc = {"metadata.root": {"package": "repro", "children": [
        {"object.entity": {"name": "Team", "children": [
            {"field.long": {"name": "id"}},
            {"identity.primary": {"name": "id", "@fields": "id"}},
        ]}},
        {"object.entity": {"name": "Match", "children": [
            {"field.long": {"name": "id"}},
            {"field.long": {"name": "homeTeamId"}},
            {"identity.primary": {"name": "id", "@fields": "id"}},
            {"identity.reference": {"name": "homeTeamRef", "@fields": ["homeTeamId"], "@references": "Team"}},
            {"relationship.association": {"name": "awayTeam", "@objectRef": "Team", "@cardinality": "one", "@sourceRefField": "awayTeamId"}},
        ]}},
    ]}}
    codes, messages = _load(doc)
    assert codes == ["ERR_INVALID_RELATIONSHIP"]
    joined = "\n".join(messages)
    assert "Match.awayTeam" in joined
    assert '"awayTeamId"' in joined


def test_declared_but_unmatched_errors_at_zero_candidate_count() -> None:
    """A declared @sourceRefField naming nothing must also error with ZERO
    candidates (no identity.reference targets the objectRef at all) -- the
    declared value is read BEFORE any candidate-count guard."""
    doc = {"metadata.root": {"package": "repro", "children": [
        {"object.entity": {"name": "Team", "children": [
            {"field.long": {"name": "id"}},
            {"identity.primary": {"name": "id", "@fields": "id"}},
        ]}},
        {"object.entity": {"name": "Match", "children": [
            {"field.long": {"name": "id"}},
            {"identity.primary": {"name": "id", "@fields": "id"}},
            {"relationship.association": {"name": "homeTeam", "@objectRef": "Team", "@cardinality": "one", "@sourceRefField": "homeTeamId"}},
        ]}},
    ]}}
    codes, messages = _load(doc)
    assert codes == ["ERR_INVALID_RELATIONSHIP"]
    joined = "\n".join(messages)
    assert "Match.homeTeam" in joined
    assert '"homeTeamId"' in joined


def test_source_ref_field_correctly_naming_single_candidate_loads_clean() -> None:
    """Regression: a correctly-declared @sourceRefField over a single
    candidate stays clean."""
    doc = {"metadata.root": {"package": "repro", "children": [
        {"object.entity": {"name": "Team", "children": [
            {"field.long": {"name": "id"}},
            {"identity.primary": {"name": "id", "@fields": "id"}},
        ]}},
        {"object.entity": {"name": "Match", "children": [
            {"field.long": {"name": "id"}},
            {"field.long": {"name": "homeTeamId"}},
            {"identity.primary": {"name": "id", "@fields": "id"}},
            {"identity.reference": {"name": "homeTeamRef", "@fields": ["homeTeamId"], "@references": "Team"}},
            {"relationship.association": {"name": "homeTeam", "@objectRef": "Team", "@cardinality": "one", "@sourceRefField": "homeTeamId"}},
        ]}},
    ]}}
    codes, _ = _load(doc)
    assert codes == []


def test_composite_reference_candidates_render_full_field_tuple() -> None:
    """Two composite references sharing a first column must still print
    distinguishably in the candidate list (fields[0] alone would collide)."""
    doc = {"metadata.root": {"package": "repro", "children": [
        {"object.entity": {"name": "Team", "children": [
            {"field.long": {"name": "id"}},
            {"identity.primary": {"name": "id", "@fields": "id"}},
        ]}},
        {"object.entity": {"name": "Match", "children": [
            {"field.long": {"name": "id"}},
            {"field.long": {"name": "tenantId"}},
            {"field.long": {"name": "homeTeamId"}},
            {"field.long": {"name": "awayTeamId"}},
            {"identity.primary": {"name": "id", "@fields": "id"}},
            {"identity.reference": {"name": "aRef", "@fields": ["tenantId", "homeTeamId"], "@references": "Team"}},
            {"identity.reference": {"name": "bRef", "@fields": ["tenantId", "awayTeamId"], "@references": "Team"}},
            {"relationship.association": {"name": "winner", "@objectRef": "Team", "@cardinality": "one"}},
        ]}},
    ]}}
    codes, messages = _load(doc)
    assert "ERR_INVALID_RELATIONSHIP" in codes
    joined = "\n".join(messages)
    assert "aRef(tenantId, homeTeamId)" in joined
    assert "bRef(tenantId, awayTeamId)" in joined


# ---------------------------------------------------------------------------
# (D) Rule (e) must iterate the EFFECTIVE relationship set.
# ---------------------------------------------------------------------------


def test_inherited_relationship_ambiguity_errors() -> None:
    """A extends cleanly; B extends A and adds a second reference onto the
    same target -- the inherited relationship becomes ambiguous on B even
    though A (and the relationship's own declaration) are untouched."""
    doc = {"metadata.root": {"package": "repro", "children": [
        {"object.entity": {"name": "Team", "children": [
            {"field.long": {"name": "id"}},
            {"identity.primary": {"name": "id", "@fields": "id"}},
        ]}},
        {"object.entity": {"name": "A", "children": [
            {"field.long": {"name": "id"}},
            {"field.long": {"name": "homeTeamId"}},
            {"identity.primary": {"name": "id", "@fields": "id"}},
            {"identity.reference": {"name": "homeTeamRef", "@fields": ["homeTeamId"], "@references": "Team"}},
            {"relationship.association": {"name": "winner", "@objectRef": "Team", "@cardinality": "one"}},
        ]}},
        {"object.entity": {"name": "B", "extends": "A", "children": [
            {"field.long": {"name": "awayTeamId"}},
            {"identity.reference": {"name": "awayTeamRef", "@fields": ["awayTeamId"], "@references": "Team"}},
        ]}},
    ]}}
    codes, messages = _load(doc)
    assert codes == ["ERR_INVALID_RELATIONSHIP"]
    joined = "\n".join(messages)
    assert "B.winner" in joined
    assert "homeTeamRef(homeTeamId)" in joined
    assert "awayTeamRef(awayTeamId)" in joined


def test_inherited_relationship_resolved_by_child_added_reference_loads_clean() -> None:
    """A child entity's added reference that name-pairs with the inherited
    relationship resolves cleanly."""
    doc = {"metadata.root": {"package": "repro", "children": [
        {"object.entity": {"name": "Team", "children": [
            {"field.long": {"name": "id"}},
            {"identity.primary": {"name": "id", "@fields": "id"}},
        ]}},
        {"object.entity": {"name": "A", "children": [
            {"field.long": {"name": "id"}},
            {"field.long": {"name": "homeTeamId"}},
            {"identity.primary": {"name": "id", "@fields": "id"}},
            {"identity.reference": {"name": "homeTeamRef", "@fields": ["homeTeamId"], "@references": "Team"}},
            {"relationship.association": {"name": "awayTeam", "@objectRef": "Team", "@cardinality": "one"}},
        ]}},
        {"object.entity": {"name": "B", "extends": "A", "children": [
            {"field.long": {"name": "awayTeamId"}},
            {"identity.reference": {"name": "awayTeamRef", "@fields": ["awayTeamId"], "@references": "Team"}},
        ]}},
    ]}}
    codes, _ = _load(doc)
    assert codes == []


# ---------------------------------------------------------------------------
# (D) Rule (d) dedupe -- own attrs never change per inheriting entity, so an
# inherited unmodified relationship must be reported exactly once.
# ---------------------------------------------------------------------------


def test_rule_d_dedupe_single_error_for_one_inheriting_child() -> None:
    doc = {"metadata.root": {"package": "repro", "children": [
        {"object.entity": {"name": "Program", "children": [
            {"field.long": {"name": "id"}},
            {"identity.primary": {"name": "id", "@fields": "id"}},
        ]}},
        {"object.entity": {"name": "A", "children": [
            {"field.long": {"name": "id"}},
            {"relationship.composition": {"name": "program", "@objectRef": "Program", "@cardinality": "one", "@through": "X"}},
            {"identity.primary": {"name": "id", "@fields": "id"}},
        ]}},
        {"object.entity": {"name": "B", "extends": "A"}},
    ]}}
    codes, _ = _load(doc)
    assert codes == ["ERR_INVALID_RELATIONSHIP"]


def test_rule_d_dedupe_single_error_across_several_inheriting_children() -> None:
    doc = {"metadata.root": {"package": "repro", "children": [
        {"object.entity": {"name": "Program", "children": [
            {"field.long": {"name": "id"}},
            {"identity.primary": {"name": "id", "@fields": "id"}},
        ]}},
        {"object.entity": {"name": "A", "children": [
            {"field.long": {"name": "id"}},
            {"relationship.composition": {"name": "program", "@objectRef": "Program", "@cardinality": "one", "@through": "X"}},
            {"identity.primary": {"name": "id", "@fields": "id"}},
        ]}},
        {"object.entity": {"name": "B", "extends": "A"}},
        {"object.entity": {"name": "C", "extends": "A"}},
        {"object.entity": {"name": "D", "extends": "A"}},
    ]}}
    codes, _ = _load(doc)
    assert codes == ["ERR_INVALID_RELATIONSHIP"]


# ---------------------------------------------------------------------------
# Regression: valid M:N still loads clean.
# ---------------------------------------------------------------------------


def test_valid_hetero_m2m_produces_no_relationship_errors() -> None:
    doc = {"metadata.root": {"package": "acme", "children": [
        {"object.entity": {"name": "Post", "children": [
            {"field.long": {"name": "id"}},
            {"relationship.association": {"name": "tags", "@cardinality": "many", "@objectRef": "Tag", "@through": "PostTag"}},
            {"identity.primary": {"name": "id", "@fields": "id"}},
        ]}},
        {"object.entity": {"name": "Tag", "children": [
            {"field.long": {"name": "id"}},
            {"identity.primary": {"name": "id", "@fields": "id"}},
        ]}},
        {"object.entity": {"name": "PostTag", "children": [
            {"field.long": {"name": "id"}},
            {"field.long": {"name": "postId"}},
            {"field.long": {"name": "tagId"}},
            {"identity.primary": {"name": "id", "@fields": "id"}},
            {"identity.reference": {"name": "p", "@fields": ["postId"], "@references": "Post"}},
            {"identity.reference": {"name": "t", "@fields": ["tagId"], "@references": "Tag"}},
        ]}},
    ]}}
    codes, _ = _load(doc)
    assert "ERR_INVALID_RELATIONSHIP" not in codes
    assert "ERR_BAD_ATTR_VALUE" not in codes


# ---------------------------------------------------------------------------
# Cross-relationship state-leakage regression: a declared-but-unmatched
# @sourceRefField at 2+ candidates on one relationship must not affect a
# SIBLING relationship on the same entity whose declared field DOES match.
# Backfilled from the Java port (Issue368RelationshipReferenceValidationTest
# .siblingRelationshipWithMatchingSourceRefFieldProducesNoErrorWhileTheBadOneDoes) --
# the case most likely to catch per-relationship state accidentally shared
# across a loop iteration.
# ---------------------------------------------------------------------------


def test_sibling_relationship_with_matching_source_ref_field_produces_no_error_while_the_bad_one_does() -> None:
    doc = {"metadata.root": {"package": "repro", "children": [
        {"object.entity": {"name": "Team", "children": [
            {"field.long": {"name": "id"}},
            {"identity.primary": {"name": "id", "@fields": "id"}},
        ]}},
        {"object.entity": {"name": "Venue", "children": [
            {"field.long": {"name": "id"}},
            {"identity.primary": {"name": "id", "@fields": "id"}},
        ]}},
        {"object.entity": {"name": "Match", "children": [
            {"field.long": {"name": "id"}},
            {"field.long": {"name": "venueId"}},
            {"field.long": {"name": "alphaFk"}},
            {"field.long": {"name": "betaFk"}},
            {"identity.primary": {"name": "id", "@fields": "id"}},
            # The GOOD sibling: a single, correctly-matched candidate onto Venue.
            {"identity.reference": {"name": "venueRef", "@fields": ["venueId"], "@references": "Venue"}},
            {"relationship.association": {"name": "venue", "@objectRef": "Venue", "@cardinality": "one", "@sourceRefField": "venueId"}},
            # The BAD one: 2+ candidates onto Team, declared @sourceRefField matches neither.
            {"identity.reference": {"name": "alphaRef", "@fields": ["alphaFk"], "@references": "Team"}},
            {"identity.reference": {"name": "betaRef", "@fields": ["betaFk"], "@references": "Team"}},
            {"relationship.association": {"name": "winner", "@objectRef": "Team", "@cardinality": "one", "@sourceRefField": "doesNotExist"}},
        ]}},
    ]}}
    codes, messages = _load(doc)
    assert codes == ["ERR_INVALID_RELATIONSHIP"], f"Expected exactly one error (the bad 'winner' relationship only): {messages}"
    joined = "\n".join(messages)
    assert "Match.winner" in joined
    assert '"doesNotExist"' in joined
    # The good sibling must never be named in any error -- no state leaked
    # from evaluating "winner" into (or out of) evaluating "venue".
    assert "Match.venue" not in joined


# ---------------------------------------------------------------------------
# Two latent "obj vs. declaring entity" bugs, backfilled from the C#/Java
# ports (see Issue368RelationshipReferenceValidationTests.cs and
# Issue368RelationshipReferenceValidationTest.java). Both bugs are
# ORDER-DEPENDENT: they only manifest when an inheriting entity is visited
# by _validate_relationships's outer loop BEFORE its declaring base -- which
# is why neither was caught by the tests above when the #368 fix landed here
# (``declaring_entity = rel.parent if rel.parent is not None else obj`` in
# validation_passes.py). Each fixture pins the visit-order invariant it
# depends on via ``_load_multi``'s returned visit order, so a future change
# to iteration order fails loudly instead of silently making the test pass
# for the wrong reason.
# ---------------------------------------------------------------------------


def test_inherited_self_join_relationship_is_not_misflagged_as_non_self_join() -> None:
    """Node extends NodeBase, which declares a @symmetric self-join
    relationship onto NodeBase itself (@objectRef: "NodeBase"). Node is
    declared BEFORE NodeBase (extends is resolved order-independently by a
    deferred pass, so this is legal) so that the outer validation loop
    visits `obj = Node` FIRST -- if rule (a)'s self-join comparison used the
    visiting `obj` instead of the relationship's DECLARING entity (NodeBase,
    via rel.parent), it would wrongly conclude @objectRef "NodeBase" is not
    the (visiting) declaring entity "Node" and misfire ERR_BAD_ATTR_VALUE."""
    doc = {"metadata.root": {"package": "acme", "children": [
        {"object.entity": {"name": "Node", "extends": "NodeBase", "children": [
            {"field.long": {"name": "id"}},
            {"identity.primary": {"name": "id", "@fields": "id"}},
        ]}},
        {"object.entity": {"name": "NodeBase", "@isAbstract": True, "children": [
            {"relationship.association": {"name": "peers", "@cardinality": "many", "@objectRef": "NodeBase",
                "@through": "NodeLink", "@symmetric": True}},
        ]}},
        {"object.entity": {"name": "NodeLink", "children": [
            {"field.long": {"name": "id"}},
            {"field.long": {"name": "aId"}},
            {"field.long": {"name": "bId"}},
            {"identity.primary": {"name": "id", "@fields": "id"}},
            {"identity.reference": {"name": "a", "@fields": ["aId"], "@references": "NodeBase"}},
            {"identity.reference": {"name": "b", "@fields": ["bId"], "@references": "NodeBase"}},
        ]}},
    ]}}
    codes, messages, visit_order = _load_multi(doc)
    # Pin the iteration-order invariant this test's premise depends on: if
    # root.children() ever stopped iterating in declaration order (e.g.
    # started sorting alphabetically), "Node" would no longer be visited
    # before "NodeBase" and this test would keep passing for the wrong
    # reason -- silently no longer exercising the bug at all. Fail loudly.
    assert visit_order == ["acme::Node", "acme::NodeBase", "acme::NodeLink"], (
        "root.children() must iterate in declaration order for this test's "
        f"premise (Node visited before NodeBase) to hold; got {visit_order}"
    )
    assert "ERR_BAD_ATTR_VALUE" not in codes, messages
    assert "ERR_INVALID_RELATIONSHIP" not in codes, messages


def test_inherited_bare_through_resolves_in_the_declaring_entity_package_not_the_visiting_one() -> None:
    """WeekBase (package "base") declares a M:N relationship with a BARE
    @through "Tag" -- ADR-0042 says a bare ref resolves in the DECLARING
    entity's package ("base::Tag"), never the package of whichever entity
    inherits and visits it. Week extends WeekBase from a DIFFERENT package
    ("acme") that also happens to declare its own unrelated "Tag" entity.
    The acme source is loaded FIRST so the outer validation loop visits
    `obj = Week` before `obj = WeekBase` -- if @through resolution used the
    visiting entity's package it would wrongly bind to "acme::Tag" (which
    has zero identity.reference children) instead of "base::Tag" (which
    correctly has two)."""
    acme_doc = {"metadata.root": {"package": "acme", "children": [
        {"object.entity": {"name": "Week", "extends": "base::WeekBase", "children": [
            {"field.long": {"name": "id"}},
            {"identity.primary": {"name": "id", "@fields": "id"}},
        ]}},
        {"object.entity": {"name": "Tag", "children": [
            {"field.long": {"name": "id"}},
            {"identity.primary": {"name": "id", "@fields": "id"}},
        ]}},
    ]}}
    base_doc = {"metadata.root": {"package": "base", "children": [
        {"object.entity": {"name": "WeekBase", "@isAbstract": True, "children": [
            {"relationship.association": {"name": "tags", "@cardinality": "many", "@objectRef": "Tag", "@through": "Tag"}},
        ]}},
        {"object.entity": {"name": "Tag", "children": [
            {"field.long": {"name": "id"}},
            {"field.long": {"name": "weekId"}},
            {"field.long": {"name": "labelId"}},
            {"identity.primary": {"name": "id", "@fields": "id"}},
            {"identity.reference": {"name": "w", "@fields": ["weekId"], "@references": "base::WeekBase"}},
            {"identity.reference": {"name": "l", "@fields": ["labelId"], "@references": "base::Tag"}},
        ]}},
    ]}}
    codes, messages, visit_order = _load_multi(acme_doc, base_doc)
    # Pin the iteration-order invariant: the acme source must be fully
    # visited (Week, then acme::Tag) before base's WeekBase/Tag, or this
    # test's premise (obj = Week visited before obj = WeekBase) silently
    # stops holding and the test would keep passing without ever exercising
    # the bug.
    assert visit_order == ["acme::Week", "acme::Tag", "base::WeekBase", "base::Tag"], (
        "root.children() must iterate in source-then-declaration order for "
        f"this test's premise (Week visited before WeekBase) to hold; got {visit_order}"
    )
    assert "ERR_INVALID_RELATIONSHIP" not in codes, messages
