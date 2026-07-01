"""Unit tests for index.lookup — load, validation, @unique rejection."""
from __future__ import annotations

import json

from metaobjects import MetaDataLoader
from metaobjects.core_types import core_providers
from metaobjects.errors import ErrorCode
from metaobjects.meta.core.index.meta_index import MetaIndex
from metaobjects.shared.base_types import TYPE_INDEX


def _load(fixture: dict):
    content = json.dumps(fixture)
    return MetaDataLoader.from_string(content, providers=list(core_providers), strict=True)


def _simple_entity_with_index(index_body: dict) -> dict:
    return {
        "metadata.root": {
            "package": "test::pkg",
            "children": [
                {
                    "object.entity": {
                        "name": "Thing",
                        "children": [
                            {"field.string": {"name": "name"}},
                            {"field.long": {"name": "ownerId"}},
                            {"identity.primary": {"name": "pk", "@fields": ["name"], "@generation": "assigned"}},
                            {"index.lookup": index_body},
                        ],
                    }
                }
            ],
        }
    }


# ---------------------------------------------------------------------------
# Basic load test
# ---------------------------------------------------------------------------

def test_index_lookup_loads_successfully():
    fixture = _simple_entity_with_index({
        "name": "idx_thing_owner",
        "@fields": ["ownerId"],
    })
    result = _load(fixture)
    assert not result.errors, f"Unexpected errors: {[e.code for e in result.errors]}"
    entity = next(c for c in result.root.children() if c.name == "Thing")
    indexes = [c for c in entity.children() if c.type == TYPE_INDEX]
    assert len(indexes) == 1
    idx = indexes[0]
    assert isinstance(idx, MetaIndex)
    assert idx.sub_type == "lookup"
    assert idx.fields() == ["ownerId"]


def test_index_lookup_with_orders():
    fixture = _simple_entity_with_index({
        "name": "idx_thing_owner_desc",
        "@fields": ["ownerId"],
        "@orders": ["desc"],
    })
    result = _load(fixture)
    assert not result.errors, f"Unexpected errors: {[e.code for e in result.errors]}"


# ---------------------------------------------------------------------------
# @unique rejected on identity.secondary (ERR_UNKNOWN_ATTR)
# ---------------------------------------------------------------------------

def test_unique_rejected_on_identity_secondary():
    fixture = {
        "metadata.root": {
            "package": "test::pkg",
            "children": [
                {
                    "object.entity": {
                        "name": "Thing",
                        "children": [
                            {"field.string": {"name": "email"}},
                            {"identity.primary": {"name": "pk", "@fields": ["email"], "@generation": "assigned"}},
                            {
                                "identity.secondary": {
                                    "name": "uq_email",
                                    "@fields": ["email"],
                                    "@unique": True,
                                }
                            },
                        ],
                    }
                }
            ],
        }
    }
    result = _load(fixture)
    codes = [e.code for e in result.errors]
    assert ErrorCode.ERR_UNKNOWN_ATTR in codes, f"Expected ERR_UNKNOWN_ATTR, got: {codes}"


# ---------------------------------------------------------------------------
# @unique rejected on index.lookup (ERR_UNKNOWN_ATTR)
# ---------------------------------------------------------------------------

def test_unique_rejected_on_index_lookup():
    fixture = _simple_entity_with_index({
        "name": "idx_thing_owner",
        "@fields": ["ownerId"],
        "@unique": True,
    })
    result = _load(fixture)
    codes = [e.code for e in result.errors]
    assert ErrorCode.ERR_UNKNOWN_ATTR in codes, f"Expected ERR_UNKNOWN_ATTR, got: {codes}"


# ---------------------------------------------------------------------------
# ERR_INVALID_INDEX: missing @fields
# ---------------------------------------------------------------------------

def test_index_lookup_missing_fields_emits_err_invalid_index():
    fixture = _simple_entity_with_index({
        "name": "idx_bad",
    })
    result = _load(fixture)
    codes = [e.code for e in result.errors]
    assert ErrorCode.ERR_INVALID_INDEX in codes, f"Expected ERR_INVALID_INDEX, got: {codes}"


# ---------------------------------------------------------------------------
# ERR_INVALID_INDEX: field does not exist on entity
# ---------------------------------------------------------------------------

def test_index_lookup_unknown_field_emits_err_invalid_index():
    fixture = _simple_entity_with_index({
        "name": "idx_bad",
        "@fields": ["nonExistentField"],
    })
    result = _load(fixture)
    codes = [e.code for e in result.errors]
    assert ErrorCode.ERR_INVALID_INDEX in codes, f"Expected ERR_INVALID_INDEX, got: {codes}"
