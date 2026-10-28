"""#484 — a report column is DERIVED from its ``@of`` field, so it used to lose the field's
``view.password`` and be served. A grouped or min-ed credential stays a credential: the
report's list route and export hide it, as an entity's do."""
from __future__ import annotations

import importlib.util
import json
import re
import shutil
import sys
import tempfile
import uuid
from pathlib import Path
from typing import Any

from fastapi import FastAPI
from fastapi.testclient import TestClient

from metaobjects import MetaDataLoader
from metaobjects.codegen.generators.filter_allowlist_generator import render_filter_allowlist
from metaobjects.codegen.generators.report_export_generator import ReportExportGenerator
from metaobjects.codegen.generators.router_generator import render_router
from metaobjects.meta.core.field.credential import is_credential_field
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.meta.core.reporting.report_read_model import report_read_model
from metaobjects.shared.base_types import TYPE_OBJECT

_MODEL = {"metadata.root": {"package": "acme::acct", "children": [
    {"object.entity": {"name": "Account", "children": [
        {"source.rdb": {"@table": "accounts"}},
        {"field.long": {"name": "id"}},
        {"field.string": {"name": "name", "@required": True, "@maxLength": 40}},
        {"field.string": {"name": "pinHash", "@maxLength": 80, "children": [{"view.password": {}}]}},
        {"identity.primary": {"name": "pk", "@fields": "id", "@generation": "increment"}},
        {"dimension.attribute": {"name": "name", "@of": "Account.name"}},
        {"dimension.attribute": {"name": "pinHash", "@of": "Account.pinHash"}},
        {"measure.aggregate": {"name": "accounts", "@agg": "count", "@of": "Account.id"}},
        {"measure.aggregate": {"name": "firstPin", "@agg": "min", "@of": "Account.pinHash"}},
    ]}},
    {"object.report": {"name": "AccountsByPin", "@from": "Account", "@dimensions": ["pinHash"],
        "@measures": ["accounts"], "children": [{"source.rdb": {"@kind": "view", "@view": "v_by_pin"}}]}},
    {"object.report": {"name": "AccountPinRange", "@from": "Account", "@dimensions": ["name"],
        "@measures": ["firstPin"], "children": [{"source.rdb": {"@kind": "view", "@view": "v_pin_range"}}]}},
    {"object.report": {"name": "AccountsByName", "@from": "Account", "@dimensions": ["name"],
        "@measures": ["accounts"], "children": [{"source.rdb": {"@kind": "view", "@view": "v_by_name"}}]}},
]}}


def _models() -> dict[str, MetaObject]:
    tmp = Path(tempfile.mkdtemp(prefix="report-credential-"))
    try:
        (tmp / "meta.json").write_text(json.dumps(_MODEL))
        result = MetaDataLoader.from_directory(str(tmp))
        assert not result.errors, [e.message for e in result.errors]
        return {
            c.name: report_read_model(c, result.root)
            for c in result.root.children()
            if c.type == TYPE_OBJECT and isinstance(c, MetaObject) and c.sub_type == "report"
        }
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


_R = _models()


def _field(report: str, name: str):
    return next(f for f in _R[report].fields() if f.name == name)


def test_derived_fields_over_a_credential_are_credentials() -> None:
    assert is_credential_field(_field("AccountsByPin", "pinHash"))
    assert is_credential_field(_field("AccountPinRange", "firstPin"))
    assert not is_credential_field(_field("AccountPinRange", "name"))
    assert not is_credential_field(_field("AccountsByPin", "accounts"))


def test_router_hides_only_the_credential_columns() -> None:
    assert "hidden=('pinHash',)" in render_router(_R["AccountsByPin"])
    assert "hidden=('firstPin',)" in render_router(_R["AccountPinRange"])
    assert "hidden=" not in render_router(_R["AccountsByName"])


def test_export_names_no_credential_column() -> None:
    gen = ReportExportGenerator()
    assert 'ExportColumn("pinHash"' not in gen.render_report(_R["AccountsByPin"])
    assert 'ExportColumn("accounts"' in gen.render_report(_R["AccountsByPin"])
    assert 'ExportColumn("firstPin"' not in gen.render_report(_R["AccountPinRange"])
    assert 'ExportColumn("name"' in gen.render_report(_R["AccountsByName"])


class _Repo:
    def __init__(self, rows: list[dict[str, Any]]) -> None:
        self._rows = rows

    def list(self, limit: int, offset: int, sort: Any, filters: list[Any]) -> list[Any]:
        return [dict(r) for r in self._rows]

    def count(self, filters: list[Any]) -> int:
        return len(self._rows)


def test_served_report_list_omits_the_credential_key_over_http() -> None:
    report = _R["AccountsByPin"]
    pkg = f"genrep_{uuid.uuid4().hex[:8]}"
    pkg_dir = Path(tempfile.mkdtemp(prefix="report-credential-gen-")) / pkg
    pkg_dir.mkdir()
    (pkg_dir / "__init__.py").write_text("")
    (pkg_dir / "accounts_by_pin_filter_allowlist.py").write_text(render_filter_allowlist(report))
    (pkg_dir / "accounts_by_pin_router.py").write_text(render_router(report))
    sys.path.insert(0, str(pkg_dir.parent))
    for name, init in ((pkg, "__init__.py"), (f"{pkg}.accounts_by_pin_router", "accounts_by_pin_router.py")):
        spec = importlib.util.spec_from_file_location(
            name, pkg_dir / init, submodule_search_locations=[str(pkg_dir)] if init == "__init__.py" else None
        )
        mod = importlib.util.module_from_spec(spec)
        sys.modules[name] = mod
        spec.loader.exec_module(mod)
    app = FastAPI()
    app.include_router(mod.router)
    app.dependency_overrides[mod.get_repository] = lambda: _Repo(
        [{"pinHash": "pin-hash-1", "accounts": 1}]
    )
    prefix = re.search(r'APIRouter\(prefix="([^"]+)"', render_router(report)).group(1)
    body = TestClient(app).get(prefix).json()
    assert body == [{"accounts": 1}]
