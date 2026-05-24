"""Unit tests for field.enum subtype — loader recognition, @values validation, and extends.

TDD: write tests first, run (expect failures), implement, run (expect pass).
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from metaobjects.core_types import core_provider
from metaobjects.errors import ErrorCode
from metaobjects.loader.meta_data_loader import load_directory
from metaobjects.meta.core.attr.attr_constants import ATTR_SUBTYPE_STRINGARRAY
from metaobjects.meta.core.field.field_constants import FIELD_ATTR_VALUES, FIELD_SUBTYPE_ENUM
from metaobjects.meta.core.field.meta_field import MetaField
from metaobjects.meta.meta_root import MetaRoot
from metaobjects.provider import compose_registry
from metaobjects.registry import TypeRegistry
from metaobjects.serializer_json import canonical_serialize
from metaobjects.shared.base_types import SUBTYPE_ROOT, TYPE_FIELD, TYPE_METADATA


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _load(doc: dict) -> tuple[list[str], str]:
    """Load a doc dict via a temp file; return (error_codes, canonical_json)."""
    import tempfile, os

    with tempfile.TemporaryDirectory() as tmpdir:
        path = os.path.join(tmpdir, "meta.test.json")
        Path(path).write_text(json.dumps(doc))
        result = load_directory(tmpdir, providers=[core_provider])
        codes = [e.code.name for e in result.errors]
        canonical = canonical_serialize(result.root)
        return codes, canonical


def _field_node(name: str, values: list[str] | None = None) -> MetaField:
    """Create a stand-alone field.enum node for validation-pass testing."""
    f = MetaField(TYPE_FIELD, FIELD_SUBTYPE_ENUM, name)
    if values is not None:
        f.set_attr(FIELD_ATTR_VALUES, values, ATTR_SUBTYPE_STRINGARRAY)
    return f


def _make_registry() -> TypeRegistry:
    return compose_registry([core_provider])


def _errors_for_field(field: MetaField) -> list[str]:
    """Run validations against a root with just this field; return error codes."""
    from metaobjects.loader.validation_passes import run_validations

    root = MetaRoot(TYPE_METADATA, SUBTYPE_ROOT, "")
    root.add_child(field)
    registry = _make_registry()
    errors: list[str] = []
    warnings: list[str] = []

    error_objs: list = []
    run_validations(root, registry, error_objs, warnings)
    return [e.code.name for e in error_objs]


# ---------------------------------------------------------------------------
# Task 7.1 — subtype constant is exported
# ---------------------------------------------------------------------------


def test_field_subtype_enum_constant() -> None:
    """FIELD_SUBTYPE_ENUM constant must equal 'enum'."""
    assert FIELD_SUBTYPE_ENUM == "enum"


def test_field_attr_values_constant() -> None:
    """FIELD_ATTR_VALUES constant must equal 'values'."""
    assert FIELD_ATTR_VALUES == "values"


# ---------------------------------------------------------------------------
# Task 7.1 — load + canonical round-trip of @values
# ---------------------------------------------------------------------------


def test_field_enum_loads_and_roundtrips() -> None:
    """field.enum with @values is recognized by the loader and round-trips canonically."""
    doc = {
        "metadata.root": {
            "package": "acme",
            "children": [
                {
                    "object.entity": {
                        "name": "Order",
                        "children": [
                            {"field.long": {"name": "id"}},
                            {
                                "field.enum": {
                                    "name": "status",
                                    "@values": ["DRAFT", "PUBLISHED", "ARCHIVED"],
                                }
                            },
                            {"identity.primary": {"@fields": "id"}},
                        ],
                    }
                }
            ],
        }
    }
    codes, canonical = _load(doc)
    assert not codes, f"Unexpected errors: {codes}"
    tree = json.loads(canonical)
    children = tree["metadata.root"]["children"][0]["object.entity"]["children"]
    enum_node = next(c for c in children if "field.enum" in c)
    assert enum_node["field.enum"]["@values"] == ["DRAFT", "PUBLISHED", "ARCHIVED"]


# ---------------------------------------------------------------------------
# Task 7.1 — missing @values → ERR_MISSING_REQUIRED_ATTR
# ---------------------------------------------------------------------------


def test_field_enum_missing_values_error() -> None:
    """field.enum with no @values must produce ERR_MISSING_REQUIRED_ATTR."""
    doc = {
        "metadata.root": {
            "package": "acme",
            "children": [
                {
                    "object.entity": {
                        "name": "Order",
                        "children": [
                            {"field.long": {"name": "id"}},
                            {"field.enum": {"name": "status"}},
                            {"identity.primary": {"@fields": "id"}},
                        ],
                    }
                }
            ],
        }
    }
    codes, _ = _load(doc)
    assert "ERR_MISSING_REQUIRED_ATTR" in codes, f"Expected ERR_MISSING_REQUIRED_ATTR; got {codes}"


# ---------------------------------------------------------------------------
# Task 7.2 — @values content validation: ERR_BAD_ATTR_VALUE cases
# ---------------------------------------------------------------------------


def test_field_enum_empty_values_error() -> None:
    """field.enum with empty @values must produce ERR_BAD_ATTR_VALUE."""
    doc = {
        "metadata.root": {
            "package": "acme",
            "children": [
                {
                    "object.entity": {
                        "name": "Order",
                        "children": [
                            {"field.long": {"name": "id"}},
                            {"field.enum": {"name": "status", "@values": []}},
                            {"identity.primary": {"@fields": "id"}},
                        ],
                    }
                }
            ],
        }
    }
    codes, _ = _load(doc)
    assert "ERR_BAD_ATTR_VALUE" in codes, f"Expected ERR_BAD_ATTR_VALUE; got {codes}"


def test_field_enum_non_identifier_member_error() -> None:
    """field.enum with a non-identifier member must produce ERR_BAD_ATTR_VALUE."""
    doc = {
        "metadata.root": {
            "package": "acme",
            "children": [
                {
                    "object.entity": {
                        "name": "Order",
                        "children": [
                            {"field.long": {"name": "id"}},
                            {"field.enum": {"name": "status", "@values": ["in-progress"]}},
                            {"identity.primary": {"@fields": "id"}},
                        ],
                    }
                }
            ],
        }
    }
    codes, _ = _load(doc)
    assert "ERR_BAD_ATTR_VALUE" in codes, f"Expected ERR_BAD_ATTR_VALUE; got {codes}"


def test_field_enum_duplicate_member_error() -> None:
    """field.enum with duplicate @values members must produce ERR_BAD_ATTR_VALUE."""
    doc = {
        "metadata.root": {
            "package": "acme",
            "children": [
                {
                    "object.entity": {
                        "name": "Order",
                        "children": [
                            {"field.long": {"name": "id"}},
                            {"field.enum": {"name": "status", "@values": ["A", "A"]}},
                            {"identity.primary": {"@fields": "id"}},
                        ],
                    }
                }
            ],
        }
    }
    codes, _ = _load(doc)
    assert "ERR_BAD_ATTR_VALUE" in codes, f"Expected ERR_BAD_ATTR_VALUE; got {codes}"


def test_field_enum_valid_values_no_errors() -> None:
    """field.enum with valid identifier members must produce no ERR_BAD_ATTR_VALUE."""
    doc = {
        "metadata.root": {
            "package": "acme",
            "children": [
                {
                    "object.entity": {
                        "name": "Order",
                        "children": [
                            {"field.long": {"name": "id"}},
                            {
                                "field.enum": {
                                    "name": "status",
                                    "@values": ["DRAFT", "PUBLISHED"],
                                }
                            },
                            {"identity.primary": {"@fields": "id"}},
                        ],
                    }
                }
            ],
        }
    }
    codes, _ = _load(doc)
    bad = [c for c in codes if c == "ERR_BAD_ATTR_VALUE"]
    assert not bad, f"Unexpected ERR_BAD_ATTR_VALUE: {codes}"


# ---------------------------------------------------------------------------
# Task 7.2 — abstract field.enum + extends (own-only validation)
# ---------------------------------------------------------------------------


def test_abstract_field_enum_extends_inherits_values() -> None:
    """A concrete field.enum that extends an abstract enum inherits @values and
    the loader does NOT re-validate them on the concrete field (own-only rule)."""
    doc = {
        "metadata.root": {
            "package": "acme",
            "children": [
                {
                    "field.enum": {
                        "name": "Status",
                        "abstract": True,
                        "@values": ["DRAFT", "PUBLISHED", "ARCHIVED"],
                    }
                },
                {
                    "object.entity": {
                        "name": "Order",
                        "children": [
                            {"field.long": {"name": "id"}},
                            {"field.enum": {"name": "status", "extends": "Status"}},
                            {"identity.primary": {"@fields": "id"}},
                        ],
                    }
                },
            ],
        }
    }
    codes, canonical = _load(doc)
    # No errors — the abstract field has valid @values; the concrete field inherits without re-check
    assert not codes, f"Unexpected errors: {codes}"
    # Inherited @values should be accessible via the effective attrs on the concrete field
    tree = json.loads(canonical)
    order_children = tree["metadata.root"]["children"][1]["object.entity"]["children"]
    status_node = next(c for c in order_children if "field.enum" in c)
    # The concrete field's own serialization does NOT include @values (own-only in canonical output)
    assert "@values" not in status_node["field.enum"], (
        "Concrete extends field must not redeclare @values in canonical output"
    )


def test_abstract_field_enum_with_bad_own_member_errors() -> None:
    """An abstract field.enum with a bad OWN member must error even with no concrete subtype."""
    doc = {
        "metadata.root": {
            "package": "acme",
            "children": [
                {
                    "field.enum": {
                        "name": "Status",
                        "abstract": True,
                        "@values": ["in-progress"],  # invalid identifier
                    }
                },
            ],
        }
    }
    codes, _ = _load(doc)
    assert "ERR_BAD_ATTR_VALUE" in codes, f"Expected ERR_BAD_ATTR_VALUE; got {codes}"
