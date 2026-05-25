"""Unit tests for relationship @onDelete / @onUpdate (referential actions).

Tier-1 cross-language contract:
  - Attr names: 'onDelete', 'onUpdate'
  - Action value-set: ('cascade', 'set-null', 'restrict', 'no-action') — kebab-case
  - Per-subtype @onDelete defaults: composition→cascade, aggregation→set-null,
    association→restrict (defaults applied at consumption time; the loader does
    not synthesize them, only validates explicit values).
  - @onUpdate default: cascade (subtype-independent).

The loader rejects any value outside the action set with ERR_BAD_ATTR_VALUE
(implemented via the allowed_values schema in core_types.py — single source of
truth).
"""
from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path

from metaobjects import MetaDataLoader
from metaobjects.core_types import core_provider
from metaobjects.meta.core.relationship.meta_relationship import MetaRelationship
from metaobjects.meta.core.relationship.relationship_constants import (
    ON_DELETE_DEFAULT_BY_SUBTYPE,
    ON_UPDATE_DEFAULT,
    REFERENTIAL_ACTIONS,
    RELATIONSHIP_ATTR_ON_DELETE,
    RELATIONSHIP_ATTR_ON_UPDATE,
    RELATIONSHIP_SUBTYPE_AGGREGATION,
    RELATIONSHIP_SUBTYPE_ASSOCIATION,
    RELATIONSHIP_SUBTYPE_COMPOSITION,
)
from metaobjects.shared.base_types import TYPE_RELATIONSHIP


# ---------------------------------------------------------------------------
# Constants — Tier-1 cross-language contract
# ---------------------------------------------------------------------------


def test_referential_attr_name_constants() -> None:
    """Attr names must equal TS + Java byte-for-byte."""
    assert RELATIONSHIP_ATTR_ON_DELETE == "onDelete"
    assert RELATIONSHIP_ATTR_ON_UPDATE == "onUpdate"


def test_referential_actions_value_set() -> None:
    """Action set must be kebab-case (no 'setDefault'); order pins migrate-ts FkAction."""
    assert REFERENTIAL_ACTIONS == ("cascade", "set-null", "restrict", "no-action")


def test_on_delete_defaults_by_subtype() -> None:
    """Per-subtype @onDelete defaults (consumption-time, not validation-time)."""
    assert ON_DELETE_DEFAULT_BY_SUBTYPE[RELATIONSHIP_SUBTYPE_COMPOSITION] == "cascade"
    assert ON_DELETE_DEFAULT_BY_SUBTYPE[RELATIONSHIP_SUBTYPE_AGGREGATION] == "set-null"
    assert ON_DELETE_DEFAULT_BY_SUBTYPE[RELATIONSHIP_SUBTYPE_ASSOCIATION] == "restrict"


def test_on_update_default_is_cascade() -> None:
    """@onUpdate default is subtype-independent: cascade."""
    assert ON_UPDATE_DEFAULT == "cascade"


# ---------------------------------------------------------------------------
# Accessors
# ---------------------------------------------------------------------------


def test_on_delete_accessor_none_when_unset() -> None:
    """meta-relationship.on_delete() returns None when not authored (default applied later)."""
    r = MetaRelationship(TYPE_RELATIONSHIP, RELATIONSHIP_SUBTYPE_COMPOSITION, "items")
    assert r.on_delete() is None
    assert r.on_update() is None


def test_on_delete_accessor_returns_authored_value() -> None:
    r = MetaRelationship(TYPE_RELATIONSHIP, RELATIONSHIP_SUBTYPE_ASSOCIATION, "owner")
    r.set_attr(RELATIONSHIP_ATTR_ON_DELETE, "cascade", sub_type="string")
    r.set_attr(RELATIONSHIP_ATTR_ON_UPDATE, "no-action", sub_type="string")
    assert r.on_delete() == "cascade"
    assert r.on_update() == "no-action"


# ---------------------------------------------------------------------------
# Loader integration — allowed-values gate
# ---------------------------------------------------------------------------


def _load(doc: dict) -> list[str]:
    with tempfile.TemporaryDirectory() as tmpdir:
        path = os.path.join(tmpdir, "meta.test.json")
        Path(path).write_text(json.dumps(doc))
        result = MetaDataLoader.from_directory(tmpdir, providers=[core_provider])
        return [e.code.name for e in result.errors]


def _two_entity_doc(child_attrs: dict[str, str]) -> dict:
    """A two-entity doc: Program -> Week composition with overridable referential actions."""
    return {
        "metadata.root": {
            "package": "acme",
            "children": [
                {
                    "object.entity": {
                        "name": "Program",
                        "children": [
                            {"source.rdb": {"@table": "programs"}},
                            {"field.long": {"name": "id"}},
                            {"identity.primary": {"@fields": "id"}},
                            {
                                "relationship.composition": {
                                    "name": "weeks",
                                    "@objectRef": "Week",
                                    "@cardinality": "one-to-many",
                                    **{f"@{k}": v for k, v in child_attrs.items()},
                                }
                            },
                        ],
                    }
                },
                {
                    "object.entity": {
                        "name": "Week",
                        "children": [
                            {"source.rdb": {"@table": "weeks"}},
                            {"field.long": {"name": "id"}},
                            {"field.long": {"name": "programId"}},
                            {"identity.primary": {"@fields": "id"}},
                        ],
                    }
                },
            ],
        }
    }


def test_valid_on_delete_action_loads_ok() -> None:
    """Every member of REFERENTIAL_ACTIONS is accepted as @onDelete."""
    for action in REFERENTIAL_ACTIONS:
        codes = _load(_two_entity_doc({"onDelete": action}))
        assert "ERR_BAD_ATTR_VALUE" not in codes, f"{action!r} should be valid; got {codes}"


def test_valid_on_update_action_loads_ok() -> None:
    """Every member of REFERENTIAL_ACTIONS is accepted as @onUpdate."""
    for action in REFERENTIAL_ACTIONS:
        codes = _load(_two_entity_doc({"onUpdate": action}))
        assert "ERR_BAD_ATTR_VALUE" not in codes, f"{action!r} should be valid; got {codes}"


def test_invalid_on_delete_rejected() -> None:
    """Out-of-set @onDelete value → ERR_BAD_ATTR_VALUE."""
    codes = _load(_two_entity_doc({"onDelete": "setDefault"}))
    assert "ERR_BAD_ATTR_VALUE" in codes, f"Expected ERR_BAD_ATTR_VALUE; got {codes}"


def test_invalid_on_update_rejected() -> None:
    """Out-of-set @onUpdate value → ERR_BAD_ATTR_VALUE."""
    codes = _load(_two_entity_doc({"onUpdate": "RESTRICT"}))  # wrong case — should reject
    assert "ERR_BAD_ATTR_VALUE" in codes, f"Expected ERR_BAD_ATTR_VALUE; got {codes}"
