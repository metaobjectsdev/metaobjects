"""#246 — field.enum extends-a-shared-enum-AND-declares-own-@values conflict.

Mirrors the TS reference test
(server/typescript/packages/metadata/test/enum-extends-values-conflict.test.ts):
a field.enum that both `extends` a shared PACKAGE-LEVEL abstract enum AND
declares its own `@values` must fail to load with
ERR_ENUM_EXTENDS_VALUES_CONFLICT — one shared enum type has one member set, so
the own `@values` would be silently dropped by the shared-enum codegen
collapse.

Three cases (the third pins the "root-level" clause of the predicate — Task 3's
review required it: dropping `sup.parent.type == TYPE_METADATA` would let a
non-root abstract super go unrejected):

  1. CONFLICT — extends a root-level (metadata.root child) abstract enum, and
     also declares its own @values.
  2. LEGAL — extends a CONCRETE (non-abstract) enum, and also declares its own
     @values.
  3. LEGAL — extends an ABSTRACT but NON-ROOT enum (declared as a child of an
     object.entity, not the shared package level), and also declares its own
     @values.
"""
from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path

from metaobjects import MetaDataLoader
from metaobjects.core_types import core_provider
from metaobjects.errors import ErrorCode


def _load_codes(doc: dict) -> list[ErrorCode]:
    """Load a doc dict via a temp file; return the loader's error codes."""
    with tempfile.TemporaryDirectory() as tmpdir:
        path = os.path.join(tmpdir, "meta.test.json")
        Path(path).write_text(json.dumps(doc))
        result = MetaDataLoader.from_directory(tmpdir, providers=[core_provider])
        return [e.code for e in result.errors]


def test_conflict_extends_root_level_abstract_enum_with_own_values() -> None:
    """Extending a root-level (shared, package-level) abstract enum while also
    declaring own @values must fail with ERR_ENUM_EXTENDS_VALUES_CONFLICT."""
    doc = {
        "metadata.root": {
            "package": "acme",
            "children": [
                {
                    "field.enum": {
                        "name": "Status",
                        "abstract": True,
                        "@values": ["A", "B"],
                    }
                },
                {
                    "object.entity": {
                        "name": "Order",
                        "children": [
                            {"field.long": {"name": "id"}},
                            {
                                "field.enum": {
                                    "name": "status",
                                    "extends": "acme::Status",
                                    "@values": ["A", "B", "C"],
                                }
                            },
                            {"identity.primary": {"@fields": "id"}},
                        ],
                    }
                },
            ],
        }
    }
    codes = _load_codes(doc)
    assert codes.count(ErrorCode.ERR_ENUM_EXTENDS_VALUES_CONFLICT) == 1, (
        f"Expected exactly one ERR_ENUM_EXTENDS_VALUES_CONFLICT; got {codes}"
    )


def test_legal_extends_concrete_enum_with_own_values() -> None:
    """Extending a CONCRETE (non-abstract) enum while also declaring own
    @values is legal — no ERR_ENUM_EXTENDS_VALUES_CONFLICT."""
    doc = {
        "metadata.root": {
            "package": "acme",
            "children": [
                {
                    "field.enum": {
                        "name": "Status",
                        "@values": ["A", "B"],
                    }
                },
                {
                    "object.entity": {
                        "name": "Order",
                        "children": [
                            {"field.long": {"name": "id"}},
                            {
                                "field.enum": {
                                    "name": "status",
                                    "extends": "acme::Status",
                                    "@values": ["A", "B", "C"],
                                }
                            },
                            {"identity.primary": {"@fields": "id"}},
                        ],
                    }
                },
            ],
        }
    }
    codes = _load_codes(doc)
    assert ErrorCode.ERR_ENUM_EXTENDS_VALUES_CONFLICT not in codes, (
        f"Did not expect ERR_ENUM_EXTENDS_VALUES_CONFLICT; got {codes}"
    )


def test_legal_extends_non_root_abstract_enum_with_own_values() -> None:
    """Extending an ABSTRACT but NON-ROOT enum (nested inside an object, not
    declared at the shared package level) while also declaring own @values is
    legal — no ERR_ENUM_EXTENDS_VALUES_CONFLICT. Pins the `sup.parent.type ==
    TYPE_METADATA` clause of the predicate."""
    doc = {
        "metadata.root": {
            "package": "acme",
            "children": [
                {
                    "object.entity": {
                        "name": "Container",
                        "abstract": True,
                        "children": [
                            {
                                "field.enum": {
                                    "name": "kind",
                                    "abstract": True,
                                    "@values": ["X", "Y"],
                                }
                            }
                        ],
                    }
                },
                {
                    "object.entity": {
                        "name": "Order",
                        "children": [
                            {"field.long": {"name": "id"}},
                            {
                                "field.enum": {
                                    "name": "status",
                                    "extends": "acme::Container.kind",
                                    "@values": ["X", "Y", "Z"],
                                }
                            },
                            {"identity.primary": {"@fields": "id"}},
                        ],
                    }
                },
            ],
        }
    }
    codes = _load_codes(doc)
    assert ErrorCode.ERR_ENUM_EXTENDS_VALUES_CONFLICT not in codes, (
        f"Did not expect ERR_ENUM_EXTENDS_VALUES_CONFLICT; got {codes}"
    )
