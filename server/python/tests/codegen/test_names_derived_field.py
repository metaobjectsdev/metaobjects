"""rc.21 (U7): a derived (origin-bearing) field of a table-backed entity has no column — it is
lowered where a projection reads it — so its names entry would name a column that does not
exist. The module carries no entry for it. A projection's derived field IS a column of its
view and keeps its entry. Mirrors the TypeScript ``names-derived-field`` test."""
from __future__ import annotations

import json
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
