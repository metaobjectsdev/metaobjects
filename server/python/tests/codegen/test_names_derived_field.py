"""rc.21 (U7): a derived (origin-bearing) field of a table-backed entity has no column — it is
lowered where a projection reads it — so its names entry would name a column that does not
exist. The module carries no entry for it. A projection's derived field IS a column of its
view and keeps its entry. Mirrors the TypeScript ``names-derived-field`` test."""
from __future__ import annotations

import importlib
import json
import sys
from pathlib import Path

import metaobjects.core_types  # noqa: F401  — side-effect: registers attr classes
from metaobjects import InMemoryStringSource, MetaDataFormat, MetaDataLoader
from metaobjects.codegen.config import GenConfig
from metaobjects.codegen.generators.names_generator import names_generator
from metaobjects.codegen.runner import run_gen

MODEL = {
    "metadata.root": {
        "package": "acme",
        "children": [
            {"object.entity": {"name": "Account", "children": [
                {"source.rdb": {"@table": "accounts"}},
                {"field.long": {"name": "id"}},
                {"field.int": {"name": "score"}},
                {"field.boolean": {"name": "isHigh", "children": [
                    {"origin.computed": {"@expr": {
                        "op": "gte", "left": {"field": "score"}, "right": {"value": 4}}}}]}},
                {"identity.primary": {"name": "id", "@fields": "id"}}]}},
            {"object.projection": {"name": "AccountView", "@filter": {"isHigh": True}, "children": [
                {"source.rdb": {"@kind": "view", "@view": "v_accounts"}},
                {"field.long": {"name": "id", "extends": "Account.id"}},
                {"field.int": {"name": "doubled", "children": [
                    {"origin.computed": {"@expr": {
                        "fn": "coalesce", "args": [{"field": "score"}, {"value": 0}]}}}]}},
                {"identity.primary": {"name": "id", "extends": "Account.id"}}]}},
        ],
    }
}


def test_a_table_entitys_derived_field_has_no_names_entry_but_a_projections_keeps_its_column(
    tmp_path: Path,
) -> None:
    result = MetaDataLoader().load([
        InMemoryStringSource(json.dumps(MODEL), format=MetaDataFormat.JSON, id="derived.json"),
    ])
    assert [str(e) for e in result.errors] == []
    out = tmp_path / "gen"
    run_gen(GenConfig(out_dir=str(out), column_naming="snake_case"), result.root,
            generators=[names_generator()])
    files = {p.name: p.read_text() for p in out.rglob("*.py")}

    account = files["account_names.py"]
    assert "ACCOUNT_SCORE_COLUMN" in account
    assert "IS_HIGH" not in account
    assert '"isHigh"' not in account

    view = files["account_view_names.py"]
    assert 'ACCOUNTVIEW_DOUBLED_COLUMN: Final[str] = "doubled"' in view


# rc.21 fix round (M8): an abstract-entity fragment drops its derived field (no column of the
# tables extending it), so a write-through extender — whose read view HAS that column —
# declares the constant itself rather than re-exporting it from a super module that does not
# define it. Mirrors the TypeScript/C# M8 tests.
M8_MODEL = {
    "metadata.root": {
        "package": "acme",
        "children": [
            {"object.entity": {"name": "Tracked", "abstract": True, "children": [
                {"field.int": {"name": "score"}},
                {"field.boolean": {"name": "isHigh", "children": [
                    {"origin.computed": {"@expr": {
                        "op": "gte", "left": {"field": "score"}, "right": {"value": 4}}}}]}},
            ]}},
            {"object.entity": {"name": "Account", "extends": "Tracked", "children": [
                {"source.rdb": {"@table": "accounts"}},
                {"source.rdb": {"name": "read", "@kind": "view",
                                "@view": "v_accounts", "@role": "replica"}},
                {"field.long": {"name": "id"}},
                {"identity.primary": {"name": "id", "@fields": "id"}}]}},
            # The projection's @filter reaching isHigh is what lets the abstract entity's
            # derived field load clean (it is lowered inline where it is reached) — the same
            # shape the TypeScript/C# M8 fixtures carry.
            {"object.projection": {"name": "HighAccounts", "@filter": {"isHigh": True}, "children": [
                {"source.rdb": {"@kind": "view", "@view": "v_high_accounts"}},
                {"field.long": {"name": "id", "extends": "Account.id"}},
                {"identity.primary": {"name": "id", "extends": "Account.id"}}]}},
        ],
    }
}


def test_a_write_through_extender_declares_the_derived_column_its_fragment_drops(
    tmp_path: Path,
) -> None:
    result = MetaDataLoader().load([
        InMemoryStringSource(json.dumps(M8_MODEL), format=MetaDataFormat.JSON, id="m8.json"),
    ])
    assert [str(e) for e in result.errors] == []
    out = tmp_path / "gen"
    run_gen(GenConfig(out_dir=str(out), column_naming="snake_case"), result.root,
            generators=[names_generator()])
    files = {p.name: p.read_text() for p in out.rglob("*.py")}

    tracked = files["tracked_names.py"]
    assert "IS_HIGH" not in tracked
    account = files["account_names.py"]
    assert 'ACCOUNT_IS_HIGH_COLUMN: Final[str] = "is_high"' in account
    assert "TRACKED_IS_HIGH_COLUMN" not in account

    # The failure mode the fix closes is at IMPORT time: before it, account_names re-exported
    # TRACKED_IS_HIGH_COLUMN from a module that does not define it — an ImportError. Import
    # the generated package for real, as the compile-conformance lane does.
    account_path = next(p for p in out.rglob("account_names.py"))
    dotted = ".".join(account_path.relative_to(tmp_path).with_suffix("").parts)
    saved = list(sys.path)
    sys.path.insert(0, str(tmp_path))
    try:
        module = importlib.import_module(dotted)
        assert module.ACCOUNT_IS_HIGH_COLUMN == "is_high"
    finally:
        sys.path[:] = saved
        for name in [m for m in sys.modules if m.split(".")[0] == dotted.split(".")[0]]:
            del sys.modules[name]
