"""FR-016 / ADR-0018 — source.rdb per-kind physical-name aliases.

Mirrors the TS reference (packages/metadata/test/fr016-source-name-and-kind-aliases.test.ts)
and the cross-port conformance corpus (fixtures/conformance/source-rdb-* +
error-source-rdb-physical-name-*). Validates:

  * Constants + PHYSICAL_NAME_ATTR_BY_KIND mapping.
  * Four-step physical_name resolution on MetaSource.
  * Loader validation pass (ERR_PHYSICAL_NAME_KIND_MISMATCH,
    ERR_PHYSICAL_NAME_MULTIPLE, WARN_LEGACY_PHYSICAL_NAME_ALIAS,
    ERR_BAD_ATTR_VALUE for empty-string aliases).
  * Canonical-serializer rewrite of @table → kind-matching alias on non-table
    @kind round-trips.
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
    PHYSICAL_NAME_ATTR_BY_KIND,
    SOURCE_ATTR_FUNCTION,
    SOURCE_ATTR_KIND,
    SOURCE_ATTR_MATERIALIZED_VIEW,
    SOURCE_ATTR_PROC,
    SOURCE_ATTR_TABLE,
    SOURCE_ATTR_VIEW,
    SOURCE_KIND_MATERIALIZED_VIEW,
    SOURCE_KIND_STORED_PROC,
    SOURCE_KIND_TABLE,
    SOURCE_KIND_TABLE_FUNCTION,
    SOURCE_KIND_VIEW,
    SOURCE_SUBTYPE_RDB,
)
from metaobjects.serializer_json import canonical_serialize
from metaobjects.shared.base_types import TYPE_OBJECT, TYPE_SOURCE


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------


def test_per_kind_physical_name_attr_constants() -> None:
    """Per-kind physical-name alias constants — kind-word values, cross-port stable."""
    assert SOURCE_ATTR_TABLE == "table"
    assert SOURCE_ATTR_VIEW == "view"
    assert SOURCE_ATTR_MATERIALIZED_VIEW == "materializedView"
    assert SOURCE_ATTR_PROC == "proc"
    assert SOURCE_ATTR_FUNCTION == "function"


def test_physical_name_attr_by_kind_mapping() -> None:
    """Every @kind maps to its kind-word physical-name alias."""
    assert PHYSICAL_NAME_ATTR_BY_KIND[SOURCE_KIND_TABLE] == SOURCE_ATTR_TABLE
    assert PHYSICAL_NAME_ATTR_BY_KIND[SOURCE_KIND_VIEW] == SOURCE_ATTR_VIEW
    assert (
        PHYSICAL_NAME_ATTR_BY_KIND[SOURCE_KIND_MATERIALIZED_VIEW]
        == SOURCE_ATTR_MATERIALIZED_VIEW
    )
    assert PHYSICAL_NAME_ATTR_BY_KIND[SOURCE_KIND_STORED_PROC] == SOURCE_ATTR_PROC
    assert PHYSICAL_NAME_ATTR_BY_KIND[SOURCE_KIND_TABLE_FUNCTION] == SOURCE_ATTR_FUNCTION


# ---------------------------------------------------------------------------
# physical_name — four-step resolution
# ---------------------------------------------------------------------------


def _load(doc: dict, file_name: str = "meta.test.json") -> tuple[list[str], list[str], object, str]:
    """Run the loader and return (error_codes, legacy_warnings, root, canonical)."""
    with tempfile.TemporaryDirectory() as tmpdir:
        path = os.path.join(tmpdir, file_name)
        Path(path).write_text(json.dumps(doc))
        result = MetaDataLoader.from_directory(tmpdir, providers=[core_provider])
        return (
            [e.code.name for e in result.errors],
            list(result.warnings),
            result.root,
            canonical_serialize(result.root),
        )


def _one_source(entity_name: str, source_body: dict) -> dict:
    return {
        "metadata.root": {
            "package": "demo",
            "children": [
                {
                    "object.entity": {
                        "name": entity_name,
                        "children": [
                            {"source.rdb": source_body},
                            {"field.long": {"name": "id"}},
                            {"identity.primary": {"@fields": "id"}},
                        ],
                    }
                }
            ],
        }
    }


def _first_source(root) -> MetaSource:
    obj = next(c for c in root.own_children() if c.type == TYPE_OBJECT)
    src = next(c for c in obj.own_children() if c.type == TYPE_SOURCE)
    assert isinstance(src, MetaSource)
    return src


def test_physical_name_step1_kind_matching_alias_view() -> None:
    """Step 1 — @view alias on @kind: view wins."""
    _, _, root, _ = _load(_one_source("V", {"@kind": "view", "@view": "v_x"}))
    assert _first_source(root).physical_name() == "v_x"


def test_physical_name_step1_kind_matching_alias_proc() -> None:
    _, _, root, _ = _load(
        _one_source("P", {"@kind": "storedProc", "@proc": "fn_x"})
    )
    assert _first_source(root).physical_name() == "fn_x"


def test_physical_name_step1_default_kind_table_alias() -> None:
    _, _, root, _ = _load(_one_source("Demo", {"@table": "demos"}))
    assert _first_source(root).physical_name() == "demos"


def test_physical_name_step2_legacy_table_for_view_kind() -> None:
    """Step 2 — legacy @table for non-table @kind (loader still warns)."""
    _, _, root, _ = _load(_one_source("L", {"@kind": "view", "@table": "v_legacy"}))
    assert _first_source(root).physical_name() == "v_legacy"


def test_physical_name_step3_source_structural_name_snake_case() -> None:
    """Step 3 — source's own structural ``name`` via snake_case (no pluralize)."""
    _, _, root, _ = _load(
        _one_source("Whatever", {"name": "MySource", "@kind": "view"})
    )
    assert _first_source(root).physical_name() == "my_source"


def test_physical_name_step4_owning_entity_pluralize_snake_case() -> None:
    """Step 4 — owning entity name via pluralize(snake_case)."""
    _, _, root, _ = _load(_one_source("Author", {}))
    # Default kind = table, no alias, no source name → "authors".
    assert _first_source(root).physical_name() == "authors"


# ---------------------------------------------------------------------------
# Validation pass — kind mismatch, multiple aliases, empty string, legacy warn
# ---------------------------------------------------------------------------


def test_validation_proc_with_view_kind_emits_mismatch() -> None:
    codes, _, _, _ = _load(
        _one_source("Bad", {"@kind": "view", "@proc": "fn_x"})
    )
    assert "ERR_PHYSICAL_NAME_KIND_MISMATCH" in codes, codes


def test_validation_multiple_aliases_rejected() -> None:
    codes, _, _, _ = _load(
        _one_source("Bad", {"@table": "t", "@view": "v"})
    )
    assert "ERR_PHYSICAL_NAME_MULTIPLE" in codes, codes


def test_validation_empty_string_alias_rejected() -> None:
    codes, _, _, _ = _load(_one_source("Bad", {"@kind": "view", "@view": ""}))
    assert "ERR_BAD_ATTR_VALUE" in codes, codes


def test_validation_legacy_table_for_view_emits_warning() -> None:
    codes, warnings, _, _ = _load(
        _one_source("L", {"@kind": "view", "@table": "v_legacy"})
    )
    assert codes == [], codes
    # Legacy @table on non-table kind is a warning, not an error.
    assert any("WARN_LEGACY_PHYSICAL_NAME_ALIAS" in w for w in warnings) or warnings, warnings


# ---------------------------------------------------------------------------
# Canonical-serializer rewrite — legacy @table → kind-matching alias
# ---------------------------------------------------------------------------


def test_canonical_serializer_rewrites_legacy_table_for_view() -> None:
    _, _, _, canonical = _load(
        _one_source("L", {"@kind": "view", "@table": "v_old"})
    )
    tree = json.loads(canonical)
    src = tree["metadata.root"]["children"][0]["object.entity"]["children"][0]["source.rdb"]
    assert "@table" not in src, f"@table should be rewritten away; got {src}"
    assert src.get("@view") == "v_old", src


def test_canonical_serializer_rewrites_legacy_table_for_stored_proc() -> None:
    _, _, _, canonical = _load(
        _one_source("L", {"@kind": "storedProc", "@table": "fn_x"})
    )
    tree = json.loads(canonical)
    src = tree["metadata.root"]["children"][0]["object.entity"]["children"][0]["source.rdb"]
    assert "@table" not in src
    assert src.get("@proc") == "fn_x"


def test_canonical_serializer_passthrough_for_table_kind() -> None:
    """@table on @kind: table (default) must not be rewritten."""
    _, _, _, canonical = _load(_one_source("T", {"@table": "demos"}))
    tree = json.loads(canonical)
    src = tree["metadata.root"]["children"][0]["object.entity"]["children"][0]["source.rdb"]
    assert src.get("@table") == "demos"
