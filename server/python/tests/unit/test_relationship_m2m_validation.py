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


def _load(doc: dict) -> tuple[list[str], list[str]]:
    """Load *doc* and return (error codes, error messages)."""
    result = MetaDataLoader().load([InMemoryStringSource(json.dumps(doc))])
    codes = [e.code.value for e in result.errors]
    messages = [e.message for e in result.errors]
    return codes, messages


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
