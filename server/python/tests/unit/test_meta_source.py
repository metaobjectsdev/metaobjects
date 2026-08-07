"""Unit tests for source.rdb — ADR-0007 paradigm subtype + @table/@kind/@role/@schema.

TDD: tests pin the cross-language Tier-1 contract (attr names, kind/role value sets,
read-only derivation, default behavior). Mirrors Java MetaSource + TS meta-source.
"""
from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path

from metaobjects import MetaDataLoader
from metaobjects.core_types import core_provider
from metaobjects.meta.persistence.source.meta_source import MetaSource
from metaobjects.meta.persistence.source.source_constants import (
    DEFAULT_SOURCE_KIND,
    DEFAULT_SOURCE_ROLE,
    SOURCE_ATTR_KIND,
    SOURCE_ATTR_ROLE,
    SOURCE_ATTR_SCHEMA,
    SOURCE_ATTR_TABLE,
    SOURCE_KIND_MATERIALIZED_VIEW,
    SOURCE_KIND_STORED_PROC,
    SOURCE_KIND_TABLE,
    SOURCE_KIND_TABLE_FUNCTION,
    SOURCE_KIND_VIEW,
    SOURCE_READ_ONLY_KINDS,
    SOURCE_RDB_KINDS,
    SOURCE_ROLE_PRIMARY,
    SOURCE_ROLE_REPLICA,
    SOURCE_ROLES,
    SOURCE_SUBTYPE_RDB,
    SOURCE_SUBTYPES,
)
from metaobjects.serializer_json import canonical_serialize
from metaobjects.shared.base_types import SUBTYPE_BASE, TYPE_SOURCE


# ---------------------------------------------------------------------------
# Constants — Tier-1 cross-language contract (attr names + value sets)
# ---------------------------------------------------------------------------


def test_source_subtype_rdb_constant() -> None:
    """Paradigm subtype is exactly 'rdb' (TS / Java parity)."""
    assert SOURCE_SUBTYPE_RDB == "rdb"
    assert SOURCE_SUBTYPES == (SUBTYPE_BASE, SOURCE_SUBTYPE_RDB)


def test_source_attr_name_constants() -> None:
    """Tier-1 attr names — must match TS source-constants.ts byte-for-byte."""
    assert SOURCE_ATTR_TABLE == "table"
    assert SOURCE_ATTR_KIND == "kind"
    assert SOURCE_ATTR_ROLE == "role"
    assert SOURCE_ATTR_SCHEMA == "schema"


def test_source_kind_value_set() -> None:
    """@kind value set — Tier-1 contract, must equal TS + Java."""
    assert SOURCE_KIND_TABLE == "table"
    assert SOURCE_KIND_VIEW == "view"
    assert SOURCE_KIND_MATERIALIZED_VIEW == "materializedView"
    assert SOURCE_KIND_STORED_PROC == "storedProc"
    assert SOURCE_KIND_TABLE_FUNCTION == "tableFunction"
    assert SOURCE_RDB_KINDS == (
        SOURCE_KIND_TABLE,
        SOURCE_KIND_VIEW,
        SOURCE_KIND_MATERIALIZED_VIEW,
        SOURCE_KIND_STORED_PROC,
        SOURCE_KIND_TABLE_FUNCTION,
    )


def test_source_role_value_set() -> None:
    """@role value set — Tier-1 contract."""
    assert SOURCE_ROLE_PRIMARY == "primary"
    assert SOURCE_ROLE_REPLICA == "replica"
    # Cross-language vocabulary is two members (#212); index/cache/publish/mirror
    # are reserved-not-registered. Assert content not order.
    assert set(SOURCE_ROLES) == {"primary", "replica"}


def test_source_defaults() -> None:
    """Defaults: @kind='table', @role='primary' (ADR-0007 Rule 3)."""
    assert DEFAULT_SOURCE_KIND == SOURCE_KIND_TABLE
    assert DEFAULT_SOURCE_ROLE == SOURCE_ROLE_PRIMARY


def test_read_only_kinds_membership() -> None:
    """Read-only kinds: view + materializedView + storedProc + tableFunction; table is NOT read-only."""
    assert SOURCE_KIND_TABLE not in SOURCE_READ_ONLY_KINDS
    assert SOURCE_KIND_VIEW in SOURCE_READ_ONLY_KINDS
    assert SOURCE_KIND_MATERIALIZED_VIEW in SOURCE_READ_ONLY_KINDS
    assert SOURCE_KIND_STORED_PROC in SOURCE_READ_ONLY_KINDS
    assert SOURCE_KIND_TABLE_FUNCTION in SOURCE_READ_ONLY_KINDS


# ---------------------------------------------------------------------------
# MetaSource accessors — defaults, read-only derivation
# ---------------------------------------------------------------------------


def _make_source(attrs: dict[str, str] | None = None) -> MetaSource:
    s = MetaSource(TYPE_SOURCE, SOURCE_SUBTYPE_RDB, "")
    for k, v in (attrs or {}).items():
        s.set_attr(k, v, sub_type="string")
    return s


def test_table_name_returns_authored_value() -> None:
    s = _make_source({SOURCE_ATTR_TABLE: "products"})
    assert s.table_name() == "products"


def test_table_name_none_when_absent() -> None:
    s = _make_source()
    assert s.table_name() is None


def test_effective_kind_defaults_to_table() -> None:
    s = _make_source()
    assert s.effective_kind() == SOURCE_KIND_TABLE


def test_effective_kind_returns_authored_value() -> None:
    s = _make_source({SOURCE_ATTR_KIND: SOURCE_KIND_VIEW})
    assert s.effective_kind() == SOURCE_KIND_VIEW


def test_role_defaults_to_primary() -> None:
    s = _make_source()
    assert s.role() == SOURCE_ROLE_PRIMARY


def test_role_returns_authored_value() -> None:
    s = _make_source({SOURCE_ATTR_ROLE: SOURCE_ROLE_REPLICA})
    assert s.role() == SOURCE_ROLE_REPLICA


def test_is_read_only_false_for_default_table() -> None:
    s = _make_source()
    assert s.is_read_only() is False
    assert s.is_writable() is True


def test_is_read_only_true_for_view() -> None:
    s = _make_source({SOURCE_ATTR_KIND: SOURCE_KIND_VIEW})
    assert s.is_read_only() is True
    assert s.is_writable() is False


def test_is_read_only_true_for_materialized_view() -> None:
    s = _make_source({SOURCE_ATTR_KIND: SOURCE_KIND_MATERIALIZED_VIEW})
    assert s.is_read_only() is True


def test_schema_returns_authored_value() -> None:
    s = _make_source({SOURCE_ATTR_SCHEMA: "public"})
    assert s.schema() == "public"


def test_schema_none_when_absent() -> None:
    s = _make_source()
    assert s.schema() is None


# ---------------------------------------------------------------------------
# Loader integration — source.rdb registration + canonical round-trip
# ---------------------------------------------------------------------------


def _load(doc: dict) -> tuple[list[str], str]:
    with tempfile.TemporaryDirectory() as tmpdir:
        path = os.path.join(tmpdir, "meta.test.json")
        Path(path).write_text(json.dumps(doc))
        result = MetaDataLoader.from_directory(tmpdir, providers=[core_provider])
        codes = [e.code.name for e in result.errors]
        canonical = canonical_serialize(result.root)
        return codes, canonical


def test_source_rdb_loads_with_table_attr() -> None:
    """source.rdb with @table loads cleanly + canonical round-trips."""
    doc = {
        "metadata.root": {
            "package": "acme",
            "children": [
                {
                    "object.entity": {
                        "name": "Product",
                        "children": [
                            {"source.rdb": {"@table": "products"}},
                            {"field.long": {"name": "id"}},
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
    source = next(c for c in children if "source.rdb" in c)
    assert source["source.rdb"]["@table"] == "products"


def test_source_rdb_bad_kind_rejected() -> None:
    """Unknown @kind value → ERR_BAD_ATTR_VALUE (allowed-values check)."""
    doc = {
        "metadata.root": {
            "package": "acme",
            "children": [
                {
                    "object.entity": {
                        "name": "Product",
                        "children": [
                            {"source.rdb": {"@table": "products", "@kind": "notARealKind"}},
                            {"field.long": {"name": "id"}},
                            {"identity.primary": {"@fields": "id"}},
                        ],
                    }
                }
            ],
        }
    }
    codes, _ = _load(doc)
    assert "ERR_BAD_ATTR_VALUE" in codes, f"Expected ERR_BAD_ATTR_VALUE; got {codes}"


def test_source_rdb_bad_role_rejected() -> None:
    """Unknown @role value → ERR_BAD_ATTR_VALUE."""
    doc = {
        "metadata.root": {
            "package": "acme",
            "children": [
                {
                    "object.entity": {
                        "name": "Product",
                        "children": [
                            {"source.rdb": {"@table": "products", "@role": "leader"}},
                            {"field.long": {"name": "id"}},
                            {"identity.primary": {"@fields": "id"}},
                        ],
                    }
                }
            ],
        }
    }
    codes, _ = _load(doc)
    assert "ERR_BAD_ATTR_VALUE" in codes, f"Expected ERR_BAD_ATTR_VALUE; got {codes}"


def test_source_dbtable_subtype_unknown() -> None:
    """Legacy source.dbTable is no longer registered → ERR_UNKNOWN_SUBTYPE."""
    doc = {
        "metadata.root": {
            "package": "acme",
            "children": [
                {
                    "object.entity": {
                        "name": "Product",
                        "children": [
                            {"source.dbTable": {"@name": "products"}},
                            {"field.long": {"name": "id"}},
                            {"identity.primary": {"@fields": "id"}},
                        ],
                    }
                }
            ],
        }
    }
    codes, _ = _load(doc)
    assert "ERR_UNKNOWN_SUBTYPE" in codes, f"Expected ERR_UNKNOWN_SUBTYPE; got {codes}"
