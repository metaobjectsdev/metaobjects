"""Unit tests for the one-primary multi-source rule (ADR-0007).

A persisted object may declare multiple source.rdb children (write-through CQRS),
but exactly one of them must have role == "primary" (the system of record).
The default role is "primary", so a single un-roled source satisfies the rule.

  0 sources  → skip (object isn't persisted)
  exactly 1 primary  → OK
  0 primaries        → ERR_SOURCE_NO_PRIMARY
  >1 primaries       → ERR_SOURCE_MULTIPLE_PRIMARY

Mirrors the Java + TS validation passes.
"""
from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path

from metaobjects import MetaDataLoader
from metaobjects.core_types import core_provider


def _load(doc: dict) -> list[str]:
    with tempfile.TemporaryDirectory() as tmpdir:
        path = os.path.join(tmpdir, "meta.test.json")
        Path(path).write_text(json.dumps(doc))
        result = MetaDataLoader.from_directory(tmpdir, providers=[core_provider])
        return [e.code.name for e in result.errors]


def _entity(*sources_and_extras: dict) -> dict:
    return {
        "metadata.root": {
            "package": "acme",
            "children": [
                {
                    "object.entity": {
                        "name": "Product",
                        "children": [
                            *sources_and_extras,
                            {"field.long": {"name": "id"}},
                            {"identity.primary": {"@fields": "id"}},
                        ],
                    }
                }
            ],
        }
    }


# ---------------------------------------------------------------------------
# Happy paths
# ---------------------------------------------------------------------------


def test_no_sources_skips_rule() -> None:
    """An object with no source children is unpersisted — no error."""
    codes = _load(_entity())
    assert "ERR_SOURCE_NO_PRIMARY" not in codes
    assert "ERR_SOURCE_MULTIPLE_PRIMARY" not in codes


def test_single_source_default_role_is_primary() -> None:
    """A single source with no @role defaults to primary — OK."""
    codes = _load(_entity({"source.rdb": {"@table": "products"}}))
    assert "ERR_SOURCE_NO_PRIMARY" not in codes
    assert "ERR_SOURCE_MULTIPLE_PRIMARY" not in codes


def test_single_explicit_primary_role_ok() -> None:
    """A single source explicitly tagged @role='primary' is OK."""
    codes = _load(_entity({"source.rdb": {"@table": "products", "@role": "primary"}}))
    assert "ERR_SOURCE_NO_PRIMARY" not in codes
    assert "ERR_SOURCE_MULTIPLE_PRIMARY" not in codes


def test_write_through_one_primary_one_replica_ok() -> None:
    """Two sources: one primary (default), one replica view — OK."""
    codes = _load(
        _entity(
            {"source.rdb": {"@table": "products"}},  # primary (default role)
            {"source.rdb": {"@table": "v_products_replica", "@kind": "view", "@role": "replica"}},
        )
    )
    assert "ERR_SOURCE_NO_PRIMARY" not in codes
    assert "ERR_SOURCE_MULTIPLE_PRIMARY" not in codes


# ---------------------------------------------------------------------------
# Error paths
# ---------------------------------------------------------------------------


def test_no_primary_raises_err_source_no_primary() -> None:
    """All sources are non-primary (replica/index/cache) → ERR_SOURCE_NO_PRIMARY."""
    codes = _load(
        _entity(
            {"source.rdb": {"@table": "v_products_a", "@kind": "view", "@role": "replica"}},
            {"source.rdb": {"@table": "v_products_b", "@kind": "view", "@role": "cache"}},
        )
    )
    assert "ERR_SOURCE_NO_PRIMARY" in codes, f"Expected ERR_SOURCE_NO_PRIMARY; got {codes}"
    assert "ERR_SOURCE_MULTIPLE_PRIMARY" not in codes


def test_multiple_primaries_raise_err_source_multiple_primary() -> None:
    """Two sources both tagged primary → ERR_SOURCE_MULTIPLE_PRIMARY."""
    codes = _load(
        _entity(
            {"source.rdb": {"@table": "products"}},  # primary (default role)
            {"source.rdb": {"@table": "products_archive", "@role": "primary"}},
        )
    )
    assert "ERR_SOURCE_MULTIPLE_PRIMARY" in codes, (
        f"Expected ERR_SOURCE_MULTIPLE_PRIMARY; got {codes}"
    )
    assert "ERR_SOURCE_NO_PRIMARY" not in codes
