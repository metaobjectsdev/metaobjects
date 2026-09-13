"""Direct unit tests for the #368 resolution ladder
(``metaobjects.meta.core.relationship.relationship_references``).

Python port of the TS reference suite
(``metadata/test/resolve-relationship-reference.test.ts``) -- exercises
``reference_candidates_for`` / ``resolve_relationship_reference`` directly
against a loaded model, rather than only through the loader's error output
(see ``test_relationship_m2m_validation.py`` for the loader-integration
tests covering rule (d) / rule (e)).
"""
from __future__ import annotations

import json

from metaobjects import InMemoryStringSource, MetaDataLoader
from metaobjects.meta.core.relationship.relationship_references import (
    reference_candidates_for,
    resolve_relationship_reference,
)
from metaobjects.meta.meta_data import MetaData
from metaobjects.shared.base_types import TYPE_OBJECT

_MATCH_MODEL = {"metadata.root": {"package": "repro", "children": [
    {"object.entity": {"name": "Team", "children": [
        {"field.long": {"name": "id"}},
        {"identity.primary": {"name": "id", "@fields": ["id"]}},
    ]}},
    {"object.entity": {"name": "Match", "children": [
        {"field.long": {"name": "id"}},
        {"field.long": {"name": "homeTeamId"}},
        {"field.long": {"name": "awayTeamId"}},
        {"identity.primary": {"name": "id", "@fields": ["id"]}},
        {"identity.reference": {"name": "homeTeamRef", "@fields": ["homeTeamId"], "@references": "Team"}},
        {"relationship.association": {"name": "homeTeam", "@objectRef": "Team", "@cardinality": "one"}},
        {"identity.reference": {"name": "awayTeamRef", "@fields": ["awayTeamId"], "@references": "Team"}},
        {"relationship.association": {"name": "awayTeam", "@objectRef": "Team", "@cardinality": "one"}},
    ]}},
]}}


def _find_object(root: MetaData, name: str) -> MetaData:
    return next(c for c in root.children() if c.type == TYPE_OBJECT and c.name == name)


def _load_object(doc: dict, name: str) -> MetaData:
    result = MetaDataLoader().load([InMemoryStringSource(json.dumps(doc))])
    assert result.errors == [], [e.message for e in result.errors]
    return _find_object(result.root, name)


def _load_match() -> MetaData:
    return _load_object(_MATCH_MODEL, "Match")


def test_enumerates_every_candidate_reference_for_the_target() -> None:
    candidates = reference_candidates_for(_load_match(), "Team")
    assert [c.name for c in candidates] == ["homeTeamRef", "awayTeamRef"]


def test_name_pairing_resolves_each_association_to_its_own_reference() -> None:
    match = _load_match()
    home = resolve_relationship_reference(match, "homeTeam", "Team")
    away = resolve_relationship_reference(match, "awayTeam", "Team")
    assert home is not None and home.name == "homeTeamRef"
    assert away is not None and away.name == "awayTeamRef"


def test_source_ref_field_wins_over_name_pairing() -> None:
    match = _load_match()
    resolved = resolve_relationship_reference(match, "homeTeam", "Team", "awayTeamId")
    assert resolved is not None and resolved.name == "awayTeamRef"


def test_a_single_candidate_resolves_regardless_of_name() -> None:
    doc = {"metadata.root": {"package": "repro", "children": [
        {"object.entity": {"name": "Team", "children": [
            {"field.long": {"name": "id"}},
            {"identity.primary": {"name": "id", "@fields": ["id"]}},
        ]}},
        {"object.entity": {"name": "Match", "children": [
            {"field.long": {"name": "id"}},
            {"field.long": {"name": "winnerFk"}},
            {"identity.primary": {"name": "id", "@fields": ["id"]}},
            {"identity.reference": {"name": "anythingAtAll", "@fields": ["winnerFk"], "@references": "Team"}},
            {"relationship.association": {"name": "champion", "@objectRef": "Team", "@cardinality": "one"}},
        ]}},
    ]}}
    match = _load_object(doc, "Match")
    resolved = resolve_relationship_reference(match, "champion", "Team")
    assert resolved is not None and resolved.name == "anythingAtAll"


def test_unpairable_names_return_none_rather_than_guessing() -> None:
    # #368 rule (e) flags this fixture as a load error -- it's the exact
    # ambiguity the ladder returning None exists to surface. Load with the
    # merge/validation pipeline still run (errors non-empty is expected
    # here), then assert the ladder's return value directly.
    doc = {"metadata.root": {"package": "repro", "children": [
        {"object.entity": {"name": "Team", "children": [
            {"field.long": {"name": "id"}},
            {"identity.primary": {"name": "id", "@fields": ["id"]}},
        ]}},
        {"object.entity": {"name": "Match", "children": [
            {"field.long": {"name": "id"}},
            {"field.long": {"name": "alphaFk"}},
            {"field.long": {"name": "betaFk"}},
            {"identity.primary": {"name": "id", "@fields": ["id"]}},
            {"identity.reference": {"name": "alphaRef", "@fields": ["alphaFk"], "@references": "Team"}},
            {"identity.reference": {"name": "betaRef", "@fields": ["betaFk"], "@references": "Team"}},
            {"relationship.association": {"name": "winner", "@objectRef": "Team", "@cardinality": "one"}},
        ]}},
    ]}}
    result = MetaDataLoader().load([InMemoryStringSource(json.dumps(doc))])
    assert [e.code.value for e in result.errors] == ["ERR_INVALID_RELATIONSHIP"]
    match = _find_object(result.root, "Match")
    assert resolve_relationship_reference(match, "winner", "Team") is None


def test_suffix_stripping_never_applies_to_the_relationship_name() -> None:
    # "valid" must NOT be stripped to "val" and pair with valRef.
    doc = {"metadata.root": {"package": "repro", "children": [
        {"object.entity": {"name": "Team", "children": [
            {"field.long": {"name": "id"}},
            {"identity.primary": {"name": "id", "@fields": ["id"]}},
        ]}},
        {"object.entity": {"name": "Match", "children": [
            {"field.long": {"name": "id"}},
            {"field.long": {"name": "valFk"}},
            {"field.long": {"name": "otherFk"}},
            {"identity.primary": {"name": "id", "@fields": ["id"]}},
            {"identity.reference": {"name": "valRef", "@fields": ["valFk"], "@references": "Team"}},
            {"identity.reference": {"name": "otherRef", "@fields": ["otherFk"], "@references": "Team"}},
            {"relationship.association": {"name": "valid", "@objectRef": "Team", "@cardinality": "one"}},
        ]}},
    ]}}
    result = MetaDataLoader().load([InMemoryStringSource(json.dumps(doc))])
    assert [e.code.value for e in result.errors] == ["ERR_INVALID_RELATIONSHIP"]
    match = _find_object(result.root, "Match")
    assert resolve_relationship_reference(match, "valid", "Team") is None
